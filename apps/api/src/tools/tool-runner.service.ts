import { decide } from "@marketing/shared";
import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DB } from "../db/database.module";
import { ProgressService } from "../runs/progress.service";
import { schema, type Db } from "../db";
import { readTools } from "./read-tools";
import type { ToolDefinition } from "./tool.types";

export type ToolResult =
  | { status: "ok"; result: unknown }
  | { status: "error" | "blocked"; error: string };

@Injectable()
export class ToolRunnerService {
  private readonly registry = new Map<string, ToolDefinition<any, any>>(readTools.map((t) => [t.name, t]));

  constructor(@Inject(DB) private readonly db: Db, @Optional() private readonly progress?: ProgressService) {}

  has(name: string) {
    return this.registry.has(name);
  }

  /** Tool specs in JSON-schema form, ready to hand to an LLM. */
  describe() {
    return [...this.registry.values()].map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      inputSchema: z.toJSONSchema(t.parameters, { io: "input" }),
    }));
  }

  /** Runs a tool and, for anyone watching the run, shows it as in progress until it ends. */
  async run(workspaceId: string, runId: string, name: string, rawArgs: unknown): Promise<ToolResult> {
    const end = this.progress?.begin(runId, "tool", name);
    try {
      const res = await this.execute(workspaceId, runId, name, rawArgs);
      end?.(res.status === "ok");
      return res;
    } catch (e) {
      end?.(false);
      throw e;
    }
  }

  /** Validate args, enforce policy, execute, and write an audit row either way. */
  private async execute(workspaceId: string, runId: string, name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) throw new NotFoundException(`Unknown tool: ${name}`);

    const audit = (status: "ok" | "error" | "blocked", result: unknown) =>
      this.db.insert(schema.toolCalls).values({ id: randomUUID(), workspaceId, runId, tool: name, args: rawArgs ?? null, result: result ?? null, status }).run();

    // Only read tools exist today; any write tool must be explicitly allowed by policy.
    if (!tool.readOnly && decide("publish") !== "auto") {
      const error = "Write tools require human approval";
      audit("blocked", { error });
      return { status: "blocked", error };
    }

    const parsed = tool.parameters.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const error = JSON.stringify(parsed.error.issues);
      audit("error", { error });
      return { status: "error", error: `Invalid arguments: ${error}` };
    }

    try {
      const result = await tool.execute({ db: this.db, workspaceId }, parsed.data);
      audit("ok", result);
      return { status: "ok", result };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      audit("error", { error });
      return { status: "error", error };
    }
  }

  recentCalls(workspaceId: string, limit = 50) {
    return this.db.select().from(schema.toolCalls)
      .where(eq(schema.toolCalls.workspaceId, workspaceId))
      .orderBy(desc(schema.toolCalls.createdAt)).limit(Math.min(limit, 200)).all();
  }
}

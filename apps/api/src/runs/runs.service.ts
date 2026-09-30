import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DB } from "../db/database.module";
import { schema, type Db } from "../db";

@Injectable()
export class RunsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  start(workspaceId: string, kind: string, input?: unknown, idempotencyKey?: string) {
    const id = randomUUID();
    this.db.insert(schema.agentRuns).values({ id, workspaceId, kind, status: "running", input: input ?? null, idempotencyKey: idempotencyKey ?? null }).run();
    return id;
  }

  finish(workspaceId: string, runId: string, status: "succeeded" | "failed" | "awaiting_approval", output?: unknown) {
    this.db.update(schema.agentRuns).set({ status, output: output ?? null })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workspaceId, workspaceId))).run();
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
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
    // A failed run releases its idempotency key so the same request can be retried.
    this.db.update(schema.agentRuns).set({ status, output: output ?? null, ...(status === "failed" ? { idempotencyKey: null } : {}) })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workspaceId, workspaceId))).run();
  }

  /**
   * Retires the finished reports of one kind because the data they describe is gone. The runs stay (the audit log
   * refers to them) but are no longer shown, and their key is freed so the same request is worked out afresh.
   */
  discardReports(workspaceId: string, kind: string): number {
    return this.db.update(schema.agentRuns).set({ status: "discarded", idempotencyKey: null })
      .where(and(eq(schema.agentRuns.workspaceId, workspaceId), eq(schema.agentRuns.kind, kind), eq(schema.agentRuns.status, "succeeded"))).run().changes;
  }

  /** Free the idempotency key (used as a lock that must not outlive the work). */
  releaseKey(workspaceId: string, runId: string) {
    this.db.update(schema.agentRuns).set({ idempotencyKey: null })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workspaceId, workspaceId))).run();
  }

  findByKey(workspaceId: string, idempotencyKey: string) {
    return this.db.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.workspaceId, workspaceId), eq(schema.agentRuns.idempotencyKey, idempotencyKey))).get();
  }

  get(workspaceId: string, runId: string) {
    return this.db.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.workspaceId, workspaceId), eq(schema.agentRuns.id, runId))).get();
  }

  list(workspaceId: string, kind: string, limit = 20) {
    return this.db.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.workspaceId, workspaceId), eq(schema.agentRuns.kind, kind)))
      .orderBy(desc(schema.agentRuns.createdAt)).limit(Math.min(limit, 100)).all();
  }
}

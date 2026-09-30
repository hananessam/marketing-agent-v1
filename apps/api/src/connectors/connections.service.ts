import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";

@Injectable()
export class ConnectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Never includes encryptedSecret. */
  list(workspaceId: string) {
    const c = schema.connections;
    return this.db.select({ id: c.id, provider: c.provider, accountId: c.accountId, status: c.status, lastSyncAt: c.lastSyncAt, lastError: c.lastError, lastSummary: c.lastSummary, createdAt: c.createdAt })
      .from(c).where(eq(c.workspaceId, workspaceId)).all();
  }

  /** Forgets the stored credentials. Already-synced metrics are kept. */
  remove(workspaceId: string, id: string) {
    const found = this.db.select({ id: schema.connections.id }).from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, id))).get();
    if (!found) throw new NotFoundException("Connection not found");
    this.db.delete(schema.connections).where(eq(schema.connections.id, id)).run();
    return { deleted: id };
  }
}

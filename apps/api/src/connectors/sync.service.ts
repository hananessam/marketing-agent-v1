import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { RunsService } from "../runs/runs.service";
import { addDays } from "../analytics/analysis";
import { CONNECTOR_FACTORY, type ConnectorFactory } from "./factory";
import { ConnectorAuthError } from "./http";
import type { ConnectorResult, DateRange } from "./types";

const CHUNK = 200;
const STALE_LOCK_MS = 15 * 60 * 1000;
/** Campaign ids are global primary keys, so scope connector ids to the workspace to keep tenants apart. */
export const scopedId = (workspaceId: string, id: string) => `${workspaceId.replace(/[^A-Za-z0-9]/g, "")}_${id}`;

export type SyncSummary = { campaigns: number; rows: number; range: DateRange; skipped: Record<string, number> };
export type SyncOutcome =
  | { status: "succeeded"; runId: string; summary: SyncSummary }
  | { status: "failed"; runId: string; error: string; needsReauth: boolean };

@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly runs: RunsService,
    @Inject(CONNECTOR_FACTORY) private readonly factory: ConnectorFactory,
  ) {}

  /** Pull [endDate-days+1, endDate] (default: the last `days` complete days) and upsert it. Safe to repeat. */
  async sync(workspaceId: string, connectionId: string, opts: { days?: number; endDate?: string } = {}): Promise<SyncOutcome> {
    const conn = this.db.select().from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId))).get();
    if (!conn) throw new NotFoundException("Connection not found");

    if (conn.status === "pending_account") return { status: "failed", runId: "", error: "Choose an account for this connection first", needsReauth: false };

    const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
    const endDate = opts.endDate ?? addDays(new Date().toISOString().slice(0, 10), -1);
    const range = { startDate: addDays(endDate, -(days - 1)), endDate };

    const runId = this.acquire(workspaceId, connectionId, range);
    if (!runId) return { status: "failed", runId: "", error: "A sync for this connection is already running", needsReauth: false };

    try {
      const result = await this.factory(conn).fetch(range);
      const summary = this.persist(workspaceId, result, range);
      this.db.update(schema.connections).set({ status: "ok", lastSyncAt: new Date().toISOString(), lastError: null, lastSummary: summary })
        .where(eq(schema.connections.id, connectionId)).run();
      this.runs.finish(workspaceId, runId, "succeeded", summary);
      this.runs.releaseKey(workspaceId, runId);
      return { status: "succeeded", runId, summary };
    } catch (e) {
      const needsReauth = e instanceof ConnectorAuthError;
      // Connector errors are already sanitized (no tokens/URLs); still cap the length.
      const error = (e instanceof Error ? e.message : "Sync failed").slice(0, 500);
      this.log.warn(`sync ${connectionId} failed: ${error}`);
      this.db.update(schema.connections).set({ status: needsReauth ? "needs_reauth" : "error", lastError: error })
        .where(eq(schema.connections.id, connectionId)).run();
      this.runs.finish(workspaceId, runId, "failed", { error });
      return { status: "failed", runId, error, needsReauth };
    }
  }

  /** One sync per connection at a time; a crashed run's lock expires. */
  private acquire(workspaceId: string, connectionId: string, range: DateRange): string | null {
    const key = `sync-lock:${connectionId}`;
    const held = this.runs.findByKey(workspaceId, key);
    if (held) {
      if (Date.now() - Date.parse(held.createdAt) < STALE_LOCK_MS) return null;
      this.runs.finish(workspaceId, held.id, "failed", { error: "Sync lock expired" });
    }
    try {
      return this.runs.start(workspaceId, "connector_sync", { connectionId, range }, key);
    } catch {
      return null; // lost a race with another instance
    }
  }

  private persist(workspaceId: string, result: ConnectorResult, range: DateRange): SyncSummary {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const c of result.campaigns) {
        const id = scopedId(workspaceId, c.id);
        tx.insert(schema.campaigns).values({ id, workspaceId, name: c.name, channel: c.channel, status: "active", source: c.source })
          .onConflictDoUpdate({ target: schema.campaigns.id, set: { name: c.name, channel: c.channel } }).run();
      }
      const channelOf = new Map(result.campaigns.map((c) => [c.id, c.channel]));
      for (let i = 0; i < result.rows.length; i += CHUNK) {
        const batch = result.rows.slice(i, i + CHUNK).map((r) => ({
          workspaceId, campaignId: scopedId(workspaceId, r.campaignId), channel: channelOf.get(r.campaignId)!, date: r.date,
          impressions: Math.round(r.impressions), clicks: Math.round(r.clicks), spend: r.spend,
          conversions: Math.round(r.conversions), revenue: r.revenue, ingestedAt: now,
        }));
        tx.insert(schema.campaignMetrics).values(batch).onConflictDoUpdate({
          target: [schema.campaignMetrics.workspaceId, schema.campaignMetrics.campaignId, schema.campaignMetrics.date],
          set: {
            channel: schemaExcluded("channel"), impressions: schemaExcluded("impressions"), clicks: schemaExcluded("clicks"), spend: schemaExcluded("spend"),
            conversions: schemaExcluded("conversions"), revenue: schemaExcluded("revenue"), ingestedAt: schemaExcluded("ingested_at"),
          },
        }).run();
      }
    });
    return { campaigns: result.campaigns.length, rows: result.rows.length, range, skipped: result.skipped };
  }

  /** Remove demo-seed campaigns and their data so real data isn't mixed with fake data. */
  purgeSeedData(workspaceId: string): number {
    const ids = this.db.select({ id: schema.campaigns.id }).from(schema.campaigns)
      .where(and(eq(schema.campaigns.workspaceId, workspaceId), eq(schema.campaigns.source, "seed"))).all().map((c) => c.id);
    if (!ids.length) return 0;
    this.db.transaction((tx) => {
      tx.delete(schema.campaignMetrics).where(inArray(schema.campaignMetrics.campaignId, ids)).run();
      tx.delete(schema.campaignAssets).where(inArray(schema.campaignAssets.campaignId, ids)).run();
      tx.delete(schema.experiments).where(inArray(schema.experiments.campaignId, ids)).run();
      tx.delete(schema.campaigns).where(inArray(schema.campaigns.id, ids)).run();
    });
    return ids.length;
  }
}

/** SQLite upsert: take the value we tried to insert. */
const schemaExcluded = (column: string) => sql.raw(`excluded."${column}"`);

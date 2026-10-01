import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ne } from "drizzle-orm";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { validateCron } from "../queue/cron";
import { JOB_QUEUE, type JobQueue } from "../queue/queue.port";

export const SYNC_PREFIX = "sync_";
export const syncSchedulerId = (connectionId: string) => `${SYNC_PREFIX}${connectionId}`;
export const DEFAULT_SYNC_CRON = "0 5 * * *"; // 05:00 UTC, ahead of typical morning report schedules
const SYNC_DAYS = 7; // re-pull a week: platforms restate recent days

/** Registers one daily sync job per connected account. */
@Injectable()
export class SyncScheduleService implements OnModuleInit {
  private readonly log = new Logger(SyncScheduleService.name);
  readonly cron: string;
  readonly timezone: string;
  /** Settles when the boot-time reconcile has finished (tests await it). */
  reconciled: Promise<void> = Promise.resolve();

  constructor(@Inject(DB) private readonly db: Db, @Inject(JOB_QUEUE) private readonly queue: JobQueue, env: NodeJS.ProcessEnv = process.env) {
    const cron = env.SYNC_CRON ?? DEFAULT_SYNC_CRON;
    const timezone = env.SYNC_TIMEZONE ?? "UTC";
    try {
      validateCron(cron, timezone);
      this.cron = cron;
      this.timezone = timezone;
    } catch (e) {
      this.log.warn(`Ignoring SYNC_CRON/SYNC_TIMEZONE (${e instanceof Error ? e.message : "invalid"}); using ${DEFAULT_SYNC_CRON} UTC`);
      this.cron = DEFAULT_SYNC_CRON;
      this.timezone = "UTC";
    }
  }

  /** What the dashboard shows; null when background jobs are off. */
  get info() {
    return this.queue.enabled ? { cron: this.cron, timezone: this.timezone } : null;
  }

  onModuleInit() {
    if (!this.queue.enabled) return;
    // Not awaited: a down Redis must never block API start-up.
    this.reconciled = this.reconcile().catch((e) => this.log.error(`Could not reconcile sync schedules: ${e instanceof Error ? e.message : e}`));
  }

  /** Best effort: a failure here must not fail the request that triggered it (boot reconcile retries later). */
  async schedule(conn: { id: string; workspaceId: string }): Promise<boolean> {
    if (!this.queue.enabled) return false;
    try {
      await this.queue.upsertSchedule(syncSchedulerId(conn.id), this.cron, this.timezone, { kind: "sync", workspaceId: conn.workspaceId, connectionId: conn.id, days: SYNC_DAYS });
      return true;
    } catch (e) {
      this.log.warn(`Could not schedule sync for ${conn.id}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  async unschedule(connectionId: string): Promise<void> {
    if (!this.queue.enabled) return;
    try {
      await this.queue.removeSchedule(syncSchedulerId(connectionId));
    } catch (e) {
      this.log.warn(`Could not remove sync schedule for ${connectionId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The database is the source of truth: schedule every usable connection, drop sync schedulers for ones that are gone. */
  async reconcile() {
    const conns = this.db.select({ id: schema.connections.id, workspaceId: schema.connections.workspaceId })
      .from(schema.connections).where(ne(schema.connections.status, "pending_account")).all();
    for (const c of conns) await this.queue.upsertSchedule(syncSchedulerId(c.id), this.cron, this.timezone, { kind: "sync", workspaceId: c.workspaceId, connectionId: c.id, days: SYNC_DAYS });
    const wanted = new Set(conns.map((c) => syncSchedulerId(c.id)));
    for (const id of await this.queue.listScheduleIds()) {
      if (!id.startsWith(SYNC_PREFIX) || wanted.has(id)) continue; // never touch other kinds of scheduler
      this.log.warn(`Removing orphaned sync schedule ${id}`);
      await this.queue.removeSchedule(id);
    }
  }
}

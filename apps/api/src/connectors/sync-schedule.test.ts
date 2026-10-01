import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import type { JobData, JobQueue } from "../queue/queue.port";
import { createTestDb, schema } from "../test/helpers";
import { DEFAULT_SYNC_CRON, SyncScheduleService, syncSchedulerId } from "./sync-schedule.service";

class FakeQueue implements JobQueue {
  enabled = true;
  schedules = new Map<string, { cron: string; tz: string; data: JobData }>();
  failUpsert = false;
  start() {}
  async enqueue(_d: JobData, jobId: string) { return { jobId, deduped: false }; }
  async upsertSchedule(id: string, cron: string, tz: string, data: JobData) { if (this.failUpsert) throw new Error("redis down"); this.schedules.set(id, { cron, tz, data }); }
  async removeSchedule(id: string) { this.schedules.delete(id); }
  async listScheduleIds() { return [...this.schedules.keys()]; }
  async jobInfo() { return null; }
}

let db: Db;
let queue: FakeQueue;
const make = (env: NodeJS.ProcessEnv = {}) => new SyncScheduleService(db, queue, env);
const addConn = (id: string, status: "ok" | "pending_account" | "needs_reauth" = "ok", ws = "w") =>
  db.insert(schema.connections).values({ id, workspaceId: ws, provider: "meta_ads", accountId: `act_${id}`, encryptedSecret: "x", status }).run();

beforeEach(async () => {
  db = await createTestDb();
  queue = new FakeQueue();
  db.insert(schema.workspaces).values([{ id: "w", name: "w" }, { id: "x", name: "x" }]).run();
});

describe("sync scheduling", () => {
  it("schedules a daily 7-day sync per connection (including ones needing reconnect) but not pending ones", async () => {
    addConn("a"); addConn("b", "needs_reauth"); addConn("c", "pending_account", "x");
    const svc = make();
    svc.onModuleInit(); await svc.reconciled;
    expect([...queue.schedules.keys()].sort()).toEqual([syncSchedulerId("a"), syncSchedulerId("b")]);
    expect(queue.schedules.get("sync_a")).toEqual({ cron: DEFAULT_SYNC_CRON, tz: "UTC", data: { kind: "sync", workspaceId: "w", connectionId: "a", days: 7 } });
  });

  it("is idempotent across restarts and removes schedulers whose connection is gone, without touching other kinds", async () => {
    addConn("a");
    queue.schedules.set("sync_ghost", { cron: "0 5 * * *", tz: "UTC", data: { kind: "sync", workspaceId: "w", connectionId: "ghost", days: 7 } });
    queue.schedules.set("schedule_report1", { cron: "0 8 * * 1", tz: "UTC", data: { workspaceId: "w", days: 7, notify: false } });
    const svc = make();
    svc.onModuleInit(); await svc.reconciled;
    svc.onModuleInit(); await svc.reconciled;
    expect([...queue.schedules.keys()].sort()).toEqual(["schedule_report1", "sync_a"]);
  });

  it("schedule/unschedule are best effort and no-ops when Redis is off", async () => {
    const svc = make();
    expect(await svc.schedule({ id: "n", workspaceId: "w" })).toBe(true);
    expect(queue.schedules.has("sync_n")).toBe(true);
    await svc.unschedule("n");
    expect(queue.schedules.has("sync_n")).toBe(false);

    queue.failUpsert = true;
    expect(await svc.schedule({ id: "n2", workspaceId: "w" })).toBe(false); // does not throw

    queue.enabled = false;
    queue.failUpsert = false;
    expect(await svc.schedule({ id: "n3", workspaceId: "w" })).toBe(false);
    expect(svc.info).toBeNull();
  });

  it("uses SYNC_CRON/SYNC_TIMEZONE, and falls back to the default for invalid or too-frequent values", async () => {
    const ok = make({ SYNC_CRON: "30 3 * * *", SYNC_TIMEZONE: "Africa/Cairo" });
    expect(ok.info).toEqual({ cron: "30 3 * * *", timezone: "Africa/Cairo" });
    expect(make({ SYNC_CRON: "*/5 * * * *" }).info).toEqual({ cron: DEFAULT_SYNC_CRON, timezone: "UTC" });
    expect(make({ SYNC_CRON: "nonsense" }).info?.cron).toBe(DEFAULT_SYNC_CRON);
    expect(make({ SYNC_TIMEZONE: "Mars/Base" }).info?.timezone).toBe("UTC");
  });
});

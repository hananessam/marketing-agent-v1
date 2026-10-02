import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { RunsService } from "../runs/runs.service";
import { createTestDb, schema } from "../test/helpers";
import { ConnectionsService } from "./connections.service";
import { ConnectorAuthError, ConnectorError } from "./http";
import { scopedId, SyncService } from "./sync.service";
import type { Connector, ConnectorResult } from "./types";

let db: Db;
let runs: RunsService;
let next: () => Promise<ConnectorResult>;
let fetched: { startDate: string; endDate: string }[];

const metaResult = (clicks = 100): ConnectorResult => ({
  campaigns: [{ id: "meta_1", name: "Spring", channel: "meta_ads", source: "meta_ads" }],
  rows: [
    { campaignId: "meta_1", date: "2026-03-09", impressions: 1000, clicks, spend: 20.5, conversions: 4, revenue: 120 },
    { campaignId: "meta_1", date: "2026-03-10", impressions: 1200, clicks: clicks + 1, spend: 22, conversions: 5, revenue: 150 },
  ],
  skipped: { invalid_row: 1 },
});

function make() {
  return new SyncService(db, runs, () => ({ provider: "meta_ads", fetch: async (range) => { fetched.push(range); return next(); } }) as Connector);
}
const addConn = (ws: string, id = `conn_${ws}`) =>
  db.insert(schema.connections).values({ id, workspaceId: ws, provider: "meta_ads", accountId: "act_1", encryptedSecret: "x" }).run();
const metricsFor = (ws: string) => db.select().from(schema.campaignMetrics).where(eq(schema.campaignMetrics.workspaceId, ws)).all();

beforeEach(async () => {
  db = await createTestDb();
  runs = new RunsService(db);
  fetched = [];
  next = async () => metricsResult();
  for (const ws of ["w", "other"]) { db.insert(schema.workspaces).values({ id: ws, name: ws }).run(); addConn(ws); }
});
const metricsResult = () => metaResult();

describe("sync", () => {
  it("upserts campaigns and daily rows, records status and skipped counts", async () => {
    const out = await make().sync("w", "conn_w", { days: 2, endDate: "2026-03-10" });
    expect(out).toMatchObject({ status: "succeeded", summary: { campaigns: 1, rows: 2, skipped: { invalid_row: 1 }, range: { startDate: "2026-03-09", endDate: "2026-03-10" } } });
    expect(fetched).toEqual([{ startDate: "2026-03-09", endDate: "2026-03-10" }]);

    const c = db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, "w")).all();
    expect(c).toMatchObject([{ id: "w_meta_1", name: "Spring", source: "meta_ads", channel: "meta_ads", status: "active" }]);
    expect(metricsFor("w").map((m) => [m.date, m.clicks, m.spend, m.ingestedAt.length > 10])).toEqual([["2026-03-09", 100, 20.5, true], ["2026-03-10", 101, 22, true]]);
    const conn = db.select().from(schema.connections).where(eq(schema.connections.id, "conn_w")).get()!;
    expect(conn).toMatchObject({ status: "ok", lastError: null });
    expect(conn.lastSyncAt).toBeTruthy();
  });

  it("is idempotent and picks up revised numbers (platforms restate recent days)", async () => {
    const svc = make();
    await svc.sync("w", "conn_w", { endDate: "2026-03-10" });
    next = async () => metaResult(500);
    await svc.sync("w", "conn_w", { endDate: "2026-03-10" });
    const rows = metricsFor("w");
    expect(rows).toHaveLength(2);
    expect(rows[0].clicks).toBe(500);
    expect(db.select().from(schema.campaigns).all().filter((x) => x.workspaceId === "w")).toHaveLength(1);
  });

  it("keeps tenants apart: same external campaign in two workspaces never collides", async () => {
    await make().sync("w", "conn_w", { endDate: "2026-03-10" });
    await make().sync("other", "conn_other", { endDate: "2026-03-10" });
    expect(metricsFor("w")).toHaveLength(2);
    expect(metricsFor("other")).toHaveLength(2);
    expect(scopedId("w", "meta_1")).not.toBe(scopedId("other", "meta_1"));
    await expect(make().sync("w", "conn_other")).rejects.toThrow(/not found/);
  });

  it("flags expired credentials as needs_reauth and other failures as error, keeping existing data", async () => {
    const svc = make();
    await svc.sync("w", "conn_w", { endDate: "2026-03-10" });
    next = async () => { throw new ConnectorAuthError("Meta API error 190: token expired"); };
    const a = await svc.sync("w", "conn_w", { endDate: "2026-03-11" });
    expect(a).toMatchObject({ status: "failed", needsReauth: true });
    expect(db.select().from(schema.connections).where(eq(schema.connections.id, "conn_w")).get()).toMatchObject({ status: "needs_reauth", lastError: "Meta API error 190: token expired" });

    next = async () => { throw new ConnectorError("Meta API error: boom", 500); };
    expect(await svc.sync("w", "conn_w")).toMatchObject({ status: "failed", needsReauth: false });
    expect(db.select().from(schema.connections).where(eq(schema.connections.id, "conn_w")).get()!.status).toBe("error");
    expect(metricsFor("w")).toHaveLength(2);
  });

  it("prevents overlapping syncs, releases the lock afterwards, and recovers from a dead lock", async () => {
    const svc = make();
    let release!: () => void;
    next = () => new Promise((r) => { release = () => r(metaResult()); });
    const first = svc.sync("w", "conn_w", { endDate: "2026-03-10" });
    await new Promise((r) => setTimeout(r, 0));
    expect(await svc.sync("w", "conn_w", { endDate: "2026-03-10" })).toMatchObject({ status: "failed", error: /already running/ });
    release();
    await first;
    expect(runs.findByKey("w", "sync-lock:conn_w")).toBeUndefined();

    // simulate a crashed run that left its lock behind an hour ago
    const dead = runs.start("w", "connector_sync", {}, "sync-lock:conn_w");
    db.update(schema.agentRuns).set({ createdAt: new Date(Date.now() - 3_600_000).toISOString() }).where(eq(schema.agentRuns.id, dead)).run();
    next = async () => metaResult();
    expect((await svc.sync("w", "conn_w", { endDate: "2026-03-10" })).status).toBe("succeeded");
  });

  it("refuses to sync a connection that has no account chosen yet", async () => {
    db.update(schema.connections).set({ status: "pending_account" }).where(eq(schema.connections.id, "conn_w")).run();
    expect(await make().sync("w", "conn_w")).toMatchObject({ status: "failed", error: /Choose an account/ });
    expect(fetched).toEqual([]);
  });

  it("clamps the window to 1–90 days", async () => {
    await make().sync("w", "conn_w", { days: 500, endDate: "2026-03-31" });
    expect(fetched[0]).toEqual({ startDate: "2026-01-01", endDate: "2026-03-31" });
  });
});

describe("seed purge and connections", () => {
  it("removes only seed campaigns (and their data) in the given workspace", async () => {
    db.insert(schema.campaigns).values([
      { id: "s1", workspaceId: "w", name: "Seed", channel: "google_ads", status: "active", source: "seed" },
      { id: "s2", workspaceId: "other", name: "Seed", channel: "google_ads", status: "active", source: "seed" },
      { id: "m1", workspaceId: "w", name: "Mine", channel: "google_ads", status: "draft", source: "manual" },
    ]).run();
    const m = (campaignId: string, workspaceId: string) => ({ workspaceId, campaignId, channel: "google_ads", date: "2026-03-10", impressions: 1, clicks: 1, spend: 1, conversions: 1, revenue: 1, ingestedAt: "x" });
    db.insert(schema.campaignMetrics).values([m("s1", "w"), m("s2", "other"), m("m1", "w")]).run();
    await make().sync("w", "conn_w", { endDate: "2026-03-10" });

    expect(make().purgeSeedData("w")).toBe(1);
    const left = db.select().from(schema.campaigns).all().map((c) => c.id).sort();
    expect(left).toEqual(["m1", "s2", "w_meta_1"]);
    expect(db.select().from(schema.campaignMetrics).where(and(eq(schema.campaignMetrics.campaignId, "s1"))).all()).toEqual([]);
    expect(make().purgeSeedData("w")).toBe(0);
  });

  it("lists connections without secrets and scopes removal by workspace", async () => {
    const unscheduled: string[] = [];
    const schedule = { info: { cron: "0 5 * * *", timezone: "UTC" }, unschedule: async (id: string) => { unscheduled.push(id); } };
    const svc = new ConnectionsService(db, schedule as never);
    const listed = svc.list("w");
    expect(listed).toHaveLength(1);
    expect(listed[0].autoSync).toEqual({ cron: "0 5 * * *", timezone: "UTC" });
    expect(JSON.stringify(listed)).not.toContain("encryptedSecret");
    await expect(svc.remove("w", "conn_other")).rejects.toThrow(/not found/);
    expect(unscheduled).toEqual([]);
    await svc.remove("w", "conn_w");
    expect(unscheduled).toEqual(["conn_w"]);
    expect(svc.list("w")).toEqual([]);
  });
});

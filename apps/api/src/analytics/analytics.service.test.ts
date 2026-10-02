import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, schema } from "../test/helpers";
import type { Db } from "../db";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { AnalyticsService } from "./analytics.service";
import type { Recommender, RecommenderInput } from "./recommender";
import type { ModelReport } from "./report.schema";
import { addDays } from "./analysis";

const END = "2026-03-14";
let db: Db;
let runs: RunsService;
let tools: ToolRunnerService;

function makeService(recommend: (i: RecommenderInput, call: number) => ModelReport) {
  let calls = 0;
  const inputs: RecommenderInput[] = [];
  const recommender: Recommender = { recommend: async (i) => { inputs.push(i); return recommend(i, ++calls); } };
  return { svc: new AnalyticsService(tools, runs, recommender), calls: () => calls, inputs };
}

const report = (value: number, actionType: ModelReport["recommendations"][number]["actionType"] = "fix_landing_page"): ModelReport => ({
  summary: "s", biggestChanges: ["c"], caveats: [],
  recommendations: [{
    title: "t", actionType, campaignId: "c1", action: "a", rationale: "r", measurableOutcome: "m",
    evidence: [{ campaignId: "c1", metric: "conversionRate", period: "current", value }],
  }],
});

beforeEach(async () => {
  db = await createTestDb();
  runs = new RunsService(db);
  tools = new ToolRunnerService(db);
  db.insert(schema.workspaces).values({ id: "w", name: "w" }).run();
  db.insert(schema.workspaces).values({ id: "other", name: "o" }).run();
  db.insert(schema.campaigns).values({ id: "c1", workspaceId: "w", name: "C1", channel: "meta_ads", status: "active" }).run();
  const rows = [];
  for (let i = 13; i >= 0; i--) {
    rows.push({ workspaceId: "w", campaignId: "c1", channel: "meta_ads", date: addDays(END, -i),
      impressions: 10000, clicks: 200, spend: 200, conversions: i >= 7 ? 10 : 3, revenue: i >= 7 ? 500 : 150, ingestedAt: "x" });
  }
  db.insert(schema.campaignMetrics).values(rows).run();
});

describe("analytics service", () => {
  it("runs the graph, attaches deterministic approval flags, and audits tool calls", async () => {
    const { svc } = makeService(() => report(0.015, "reallocate_budget"));
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect(res.status).toBe("succeeded");
    const out = res.output as any;
    expect(out.anomalies.map((a: any) => a.type)).toContain("conversion_rate_drop");
    expect(out.report.recommendations[0]).toMatchObject({ requiresApproval: true, policyAction: "change_budget" });
    const audit = tools.recentCalls("w").map((c) => c.tool);
    expect(audit).toEqual(expect.arrayContaining(["list_campaigns", "get_campaign_metrics"]));
    expect(tools.recentCalls("w").every((c) => c.runId === res.runId)).toBe(true);
  });

  it("does not require approval for drafts/reports", async () => {
    const { svc } = makeService(() => report(0.015, "investigate_tracking"));
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect((res.output as any).report.recommendations[0].requiresApproval).toBe(false);
  });

  it("rejects invented metrics, retries with feedback, then accepts a corrected answer", async () => {
    const { svc, calls, inputs } = makeService((_, n) => report(n === 1 ? 0.99 : 0.015));
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect(res.status).toBe("succeeded");
    expect(calls()).toBe(2);
    expect(inputs[1].feedback?.[0]).toMatch(/conversionRate is 0.015/);
  });

  it("fails (and releases the idempotency key) if the model keeps inventing numbers", async () => {
    const { svc, calls } = makeService(() => report(0.99));
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect(res.status).toBe("failed");
    expect(calls()).toBe(2);
    expect(runs.findByKey("w", `analytics:7:${END}`)).toBeUndefined();
  });

  it("is idempotent: the same request reuses the stored run without calling the model again", async () => {
    const { svc, calls } = makeService(() => report(0.015));
    const a = await svc.run("w", { endDate: END, days: 7 });
    const b = await svc.run("w", { endDate: END, days: 7 });
    expect(b.reused).toBe(true);
    expect(b.runId).toBe(a.runId);
    expect(calls()).toBe(1);
  });

  it("skips the model when there is no data", async () => {
    const { svc, calls } = makeService(() => report(0.015));
    const res = await svc.run("other", { endDate: END, days: 7 });
    expect(res.status).toBe("failed");
    expect(calls()).toBe(0);
  });

  it("surfaces model/API errors as a failed run", async () => {
    const { svc } = makeService(() => { throw new Error("boom"); });
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect(res.status).toBe("failed");
    expect((res.output as any).error).toBe("boom");
  });

  it("orders recommendations by confirmed anomaly severity, not model order", async () => {
    // Model puts the harmless campaign first; the collapsing campaign must come first in the output.
    db.insert(schema.campaigns).values({ id: "c2", workspaceId: "w", name: "C2", channel: "google_ads", status: "active" }).run();
    const rows = [];
    for (let i = 13; i >= 0; i--)
      rows.push({ workspaceId: "w", campaignId: "c2", channel: "google_ads", date: addDays(END, -i), impressions: 10000, clicks: 200, spend: 200, conversions: 10, revenue: 500, ingestedAt: "x" });
    db.insert(schema.campaignMetrics).values(rows).run();
    const rec = (campaignId: string, value: number) => ({
      title: campaignId, actionType: "fix_landing_page" as const, campaignId, action: "a", rationale: "r", measurableOutcome: "m",
      evidence: [{ campaignId, metric: "conversionRate" as const, period: "current" as const, value }],
    });
    const { svc } = makeService(() => ({ summary: "s", biggestChanges: [], caveats: [], recommendations: [rec("c2", 0.05), rec("c1", 0.015)] }));
    const res = await svc.run("w", { endDate: END, days: 7 });
    expect((res.output as any).report.recommendations.map((r: any) => r.campaignId)).toEqual(["c1", "c2"]);
  });
});

describe("refreshing a report", () => {
  it("works it out again from the data as it is now, instead of returning the earlier report", async () => {
    const { svc, calls } = makeService(() => report(0.015));
    const first = await svc.run("w", { endDate: END, days: 7 });
    expect(calls()).toBe(1);

    // the data changes after that report was made
    db.delete(schema.campaignMetrics).run();
    const same = await svc.run("w", { endDate: END, days: 7 });
    expect(same).toMatchObject({ reused: true, runId: first.runId }); // an ordinary request still reuses it
    expect(calls()).toBe(1);

    const again = await svc.run("w", { endDate: END, days: 7, refresh: true });
    expect(again.reused).toBe(false);
    expect(again.runId).not.toBe(first.runId);
    expect(again.status).toBe("failed"); // no data any more: said honestly instead of repeating the old numbers
    expect((again.output as { note: string }).note).toMatch(/No metrics/);
  });

  it("keeps the earlier report in the history, and the new one is the newest", async () => {
    const { svc } = makeService(() => report(0.015));
    const first = await svc.run("w", { endDate: END, days: 7 });
    const second = await svc.run("w", { endDate: END, days: 7, refresh: true });
    expect(second.status).toBe("succeeded");
    const listed = svc.list("w").map((r) => r.id);
    expect(listed).toEqual([second.runId, first.runId]);
    // and a later ordinary request reuses the new report, not the old one
    expect(await svc.run("w", { endDate: END, days: 7 })).toMatchObject({ reused: true, runId: second.runId });
  });

  it("does not replace a report that is being worked out right now", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new AnalyticsService(tools, runs, { recommend: async () => { await gate; return report(0.015); } });
    const inFlight = slow.run("w", { endDate: END, days: 7 });
    await new Promise((r) => setTimeout(r, 10));
    const second = await slow.run("w", { endDate: END, days: 7, refresh: true });
    expect(second.reused).toBe(true); // joined the one already running
    release();
    const first = await inFlight;
    expect(second.runId).toBe(first.runId);
  });
});

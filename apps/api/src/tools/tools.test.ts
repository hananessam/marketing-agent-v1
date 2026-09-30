import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, schema } from "../test/helpers";
import type { Db } from "../db";
import { ToolRunnerService } from "./tool-runner.service";
import { RunsService } from "../runs/runs.service";

let db: Db;
let tools: ToolRunnerService;
let runs: RunsService;

const metric = (ws: string, date: string, clicks = 100) => ({
  workspaceId: ws, campaignId: `c_${ws}`, channel: "email", date,
  impressions: 1000, clicks, spend: 50, conversions: 10, revenue: 500, ingestedAt: "2026-01-01T00:00:00Z",
});

beforeEach(async () => {
  db = await createTestDb();
  tools = new ToolRunnerService(db);
  runs = new RunsService(db);
  for (const ws of ["a", "b"]) {
    db.insert(schema.workspaces).values({ id: ws, name: ws }).run();
    db.insert(schema.campaigns).values({ id: `c_${ws}`, workspaceId: ws, name: ws, channel: "email", status: "active" }).run();
    db.insert(schema.products).values({ id: `p_${ws}`, workspaceId: ws, name: `Product ${ws}`, description: "d" }).run();
  }
  db.insert(schema.campaignMetrics).values([metric("a", "2026-01-01"), metric("a", "2026-01-03"), metric("b", "2026-01-01", 999)]).run();
});

describe("tool runner", () => {
  it("returns metrics with derived values and data-quality gaps", async () => {
    const runId = runs.start("a", "t");
    const res = await tools.run("a", runId, "get_campaign_metrics", {
      campaignId: "c_a", startDate: "2026-01-01", endDate: "2026-01-03",
    });
    expect(res.status).toBe("ok");
    const r = (res as any).result;
    expect(r.totals.clicks).toBe(200);
    expect(r.derived.ctr).toBeCloseTo(0.1);
    expect(r.dataQuality.missingDates).toEqual(["2026-01-02"]);
    expect(r.dataQuality.latestDate).toBe("2026-01-03");
  });

  it("isolates tenants: workspace B cannot read workspace A's campaign", async () => {
    const runId = runs.start("b", "t");
    const res = await tools.run("b", runId, "get_campaign_metrics", {
      campaignId: "c_a", startDate: "2026-01-01", endDate: "2026-01-03",
    });
    expect((res as any).result.daily).toEqual([]);
    const prods = await tools.run("b", runId, "get_product_information", {});
    expect((prods as any).result.map((p: any) => p.name)).toEqual(["Product b"]);
  });

  it("rejects invalid args and audits the failure", async () => {
    const runId = runs.start("a", "t");
    const res = await tools.run("a", runId, "get_campaign_metrics", { campaignId: "c_a", startDate: "nope", endDate: "2026-01-03" });
    expect(res.status).toBe("error");
    const res2 = await tools.run("a", runId, "get_campaign_metrics", { campaignId: "c_a", startDate: "2026-03-01", endDate: "2026-01-01" });
    expect(res2.status).toBe("error");
    const res3 = await tools.run("a", runId, "get_campaign_metrics", { campaignId: "c_a", startDate: "2025-01-01", endDate: "2026-01-01" });
    expect(res3.status).toBe("error"); // range > 92 days
    expect(tools.recentCalls("a").filter((c) => c.status === "error")).toHaveLength(3);
  });

  it("audits every call and scopes the audit log by workspace", async () => {
    await tools.run("a", runs.start("a", "t"), "list_campaigns", {});
    await tools.run("b", runs.start("b", "t"), "list_campaigns", {});
    expect(tools.recentCalls("a")).toHaveLength(1);
    expect(tools.recentCalls("b")).toHaveLength(1);
  });

  it("exposes JSON-schema specs for the LLM", () => {
    const spec = tools.describe().find((t) => t.name === "get_campaign_metrics")!;
    expect(spec.inputSchema).toHaveProperty("properties");
  });
});

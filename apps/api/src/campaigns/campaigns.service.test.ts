import type { CampaignBrief, CampaignPlan } from "@marketing/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { RunsService } from "../runs/runs.service";
import { createTestDb, schema } from "../test/helpers";
import { ActionsService } from "../actions/actions.service";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { CampaignsService } from "./campaigns.service";
import type { ContentAsset, ContentDraft } from "./content.schema";
import type { CampaignWriter } from "./writer";

const brief: CampaignBrief = {
  objective: "leads", product: "Acme Planner", audience: "Founders", channels: ["email"], durationDays: 14, constraints: [],
};
const plan = (over: Partial<CampaignPlan> = {}): CampaignPlan => ({
  objective: "leads", audienceSegments: ["Founders"], positioning: "Simple planning", keyMessage: "Plan faster",
  channels: [{ name: "email", role: "nurture", contentTypes: ["email_subject"], successMetrics: ["conversionRate"] }],
  experiments: [{ hypothesis: "Short subject wins", variable: "subject", variants: ["A", "B"] }], risks: [], ...over,
});
const asset = (variant: string, content: string, kind: ContentAsset["kind"] = "email_subject"): ContentAsset =>
  ({ channel: "email", kind, variant, content, claimsUsed: [] });
const goodDraft = (): ContentDraft => ({ assets: [asset("A", "Plan your week"), asset("B", "Your week, planned")] });

let db: Db;
let runs: RunsService;
let tools: ToolRunnerService;

function make(writer: Partial<CampaignWriter> & { content?: CampaignWriter["content"] }) {
  const calls = { plan: 0, content: 0, feedback: [] as (string[] | undefined)[] };
  const full: CampaignWriter = {
    plan: async () => { calls.plan++; return plan(); },
    content: async (i) => { calls.content++; calls.feedback.push(i.feedback); return goodDraft(); },
    ...writer,
  };
  return { svc: new CampaignsService(db, tools, runs, full, new ActionsService(db)), calls };
}

beforeEach(async () => {
  db = await createTestDb();
  runs = new RunsService(db);
  tools = new ToolRunnerService(db);
  for (const ws of ["w", "other"]) db.insert(schema.workspaces).values({ id: ws, name: ws }).run();
  db.insert(schema.brandProfiles).values({
    id: "bp", workspaceId: "w", voice: "friendly", approvedClaims: ["Free 30-day trial"], prohibited: ["guaranteed results"], allowedDomains: ["acme.example"],
  }).run();
  db.insert(schema.products).values({ id: "p", workspaceId: "w", name: "Acme Planner", description: "Planning SaaS" }).run();
  db.insert(schema.audiences).values({ id: "a", workspaceId: "w", name: "Founders", description: "d" }).run();
});

describe("campaign generation", () => {
  it("creates a draft campaign, assets, experiments and a pending approval (nothing published)", async () => {
    const { svc } = make({});
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("awaiting_approval");
    const { campaignId, approvalId } = res.output as { campaignId: string; approvalId: string };
    const c = svc.get("w", campaignId);
    expect(c.status).toBe("draft");
    expect(c.assets).toHaveLength(2);
    expect(c.assets.every((a) => a.status === "draft")).toBe(true);
    expect(c.experiments).toHaveLength(1);
    expect(svc.listApprovals("w", "pending").map((a) => a.id)).toEqual([approvalId]);
    // context came through audited tools
    expect(tools.recentCalls("w").map((t) => t.tool)).toEqual(expect.arrayContaining(["get_brand_guidelines", "get_product_information", "get_audience_segments"]));
  });

  it("rejects unknown products before creating anything", async () => {
    const { svc } = make({});
    await expect(svc.generate("w", { ...brief, product: "Nope" })).rejects.toThrow(/Unknown product/);
    expect(runs.list("w", "campaign_draft")).toHaveLength(0);
  });

  it("feeds policy violations back to the writer and accepts the corrected draft", async () => {
    let n = 0;
    const { svc, calls } = make({
      content: async (i) => { calls.feedback.push(i.feedback); return n++ === 0 ? { assets: [asset("A", "Guaranteed results for you"), asset("B", "Plan it")] } : goodDraft(); },
    });
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("awaiting_approval");
    expect(calls.feedback[1]?.join(" ")).toMatch(/prohibited_phrase/);
  });

  it("fails and saves nothing if the writer keeps violating policy", async () => {
    const { svc } = make({ content: async () => ({ assets: [asset("A", "Guaranteed results"), asset("B", "50% off")] }) });
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("failed");
    expect(svc.list("w")).toHaveLength(0);
    expect(svc.listApprovals("w")).toHaveLength(0);
  });

  it("rejects plans for channels that were not requested", async () => {
    const { svc, calls } = make({ plan: async () => plan({ channels: [{ name: "linkedin", role: "r", contentTypes: [], successMetrics: [] }] }) });
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("failed");
    expect(calls.content).toBe(0);
  });

  it("does not create duplicate campaigns for the same brief", async () => {
    const { svc } = make({});
    const a = await svc.generate("w", brief);
    const b = await svc.generate("w", { ...brief, channels: [...brief.channels] });
    expect(b.reused).toBe(true);
    expect(b.runId).toBe(a.runId);
    expect(svc.list("w")).toHaveLength(1);
  });
});

describe("fit problems (too long) are fixable, not fatal", () => {
  const LONG = "A subject line that is far too long for an email subject because it just keeps going and going";
  const longDraft = (): ContentDraft => ({ assets: [asset("A", LONG), asset("B", `${LONG} again`)] });

  it("retries up to three times with the exact text and overage, then saves the draft with the problems flagged", async () => {
    const { svc, calls } = make({ content: async (i) => { calls.content++; calls.feedback.push(i.feedback); return longDraft(); } });
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("awaiting_approval");
    expect(calls.content).toBe(3);
    expect(calls.feedback[1]?.join(" ")).toMatch(/shorten by at least \d+/);
    expect(calls.feedback[1]?.join(" ")).toContain(LONG.slice(0, 40));
    const out = res.output as { campaignId: string; needsFixes: string[] };
    expect(out.needsFixes).toHaveLength(2);
    const c = svc.get("w", out.campaignId);
    expect(c.assets).toHaveLength(2);
    expect(c.assets.every((a) => a.issues.some((x) => x.startsWith("too_long")))).toBe(true);
  });

  it("will not approve flawed copy, but approves it once a person has shortened it", async () => {
    const { svc } = make({ content: async () => longDraft() });
    const out = (await svc.generate("w", brief)).output as { campaignId: string; approvalId: string };
    const [a, b] = svc.get("w", out.campaignId).assets;
    expect(() => svc.reviewAsset("w", out.campaignId, a.id, "approved")).toThrow(/needs a fix/);
    expect(() => svc.editAsset("w", out.campaignId, a.id, LONG)).toThrow(/violates brand policy/); // still too long
    svc.editAsset("w", out.campaignId, a.id, "Plan your week");
    svc.reviewAsset("w", out.campaignId, a.id, "approved");
    svc.reviewAsset("w", out.campaignId, b.id, "rejected"); // the other one is simply declined
    expect(svc.get("w", out.campaignId).assets.find((x) => x.id === a.id)).toMatchObject({ status: "approved", issues: [] });
    expect(svc.decide("w", out.approvalId, "approved", "h").status).toBe("approved");
  });

  it("still rejects the whole draft when a hard rule is broken alongside a fit problem", async () => {
    const { svc } = make({ content: async () => ({ assets: [asset("A", LONG), asset("B", "Guaranteed results")] }) });
    const res = await svc.generate("w", brief);
    expect(res.status).toBe("failed");
    expect(svc.list("w")).toHaveLength(0);
  });

  it("clean drafts report no problems", async () => {
    const { svc } = make({});
    const out = (await svc.generate("w", brief)).output as { campaignId: string; needsFixes?: string[] };
    expect(out.needsFixes).toBeUndefined();
    expect(svc.get("w", out.campaignId).assets.every((a) => a.issues.length === 0)).toBe(true);
  });
});

describe("review and approval", () => {
  async function draft() {
    const { svc } = make({});
    const res = await svc.generate("w", brief);
    const { campaignId, approvalId } = res.output as { campaignId: string; approvalId: string };
    return { svc, campaignId, approvalId, assets: svc.get("w", campaignId).assets };
  }

  it("blocks approval until every asset is reviewed, then approves the campaign (still not published)", async () => {
    const { svc, campaignId, approvalId, assets } = await draft();
    expect(() => svc.decide("w", approvalId, "approved", "hanan")).toThrow(/still need review/);
    svc.reviewAsset("w", campaignId, assets[0].id, "approved");
    svc.reviewAsset("w", campaignId, assets[1].id, "rejected");
    expect(svc.decide("w", approvalId, "approved", "hanan")).toMatchObject({ status: "approved", decidedBy: "hanan" });
    expect(svc.get("w", campaignId).status).toBe("approved");
    expect(() => svc.decide("w", approvalId, "rejected", "x")).toThrow(/Already approved/);
    expect(() => svc.editAsset("w", campaignId, assets[0].id, "Changed")).toThrow(/no longer a draft/);
  });

  it("requires at least one approved asset", async () => {
    const { svc, campaignId, approvalId, assets } = await draft();
    for (const a of assets) svc.reviewAsset("w", campaignId, a.id, "rejected");
    expect(() => svc.decide("w", approvalId, "approved", "h")).toThrow(/at least one/);
  });

  it("rejecting keeps the campaign a draft", async () => {
    const { svc, campaignId, approvalId } = await draft();
    svc.decide("w", approvalId, "rejected", "h");
    expect(svc.get("w", campaignId).status).toBe("draft");
  });

  it("re-checks policy on human edits and resets review status", async () => {
    const { svc, campaignId, assets } = await draft();
    svc.reviewAsset("w", campaignId, assets[0].id, "approved");
    expect(() => svc.editAsset("w", campaignId, assets[0].id, "Guaranteed results!")).toThrow(/violates brand policy/);
    expect(svc.get("w", campaignId).assets.find((a) => a.id === assets[0].id)!.status).toBe("approved"); // failed edit changed nothing
    const edited = svc.editAsset("w", campaignId, assets[0].id, "A better subject");
    expect(edited.status).toBe("draft");
  });

  it("re-validates at approval time even if the DB was changed after review", async () => {
    const { svc, campaignId, approvalId, assets } = await draft();
    for (const a of assets) svc.reviewAsset("w", campaignId, a.id, "approved");
    db.update(schema.campaignAssets).set({ content: "Guaranteed results" }).where(eq(schema.campaignAssets.id, assets[0].id)).run();
    expect(() => svc.decide("w", approvalId, "approved", "h")).toThrow(/violate brand policy/);
  });

  it("isolates workspaces", async () => {
    const { svc, campaignId, approvalId, assets } = await draft();
    expect(() => svc.get("other", campaignId)).toThrow(/not found/);
    expect(() => svc.reviewAsset("other", campaignId, assets[0].id, "approved")).toThrow(/not found/);
    expect(() => svc.decide("other", approvalId, "approved", "h")).toThrow(/not found/);
    expect(svc.listApprovals("other")).toEqual([]);
  });
});

describe("rejection is not a dead end", () => {
  async function drafted() {
    const { svc } = make({});
    const out = (await svc.generate("w", brief)).output as { campaignId: string; approvalId: string };
    return { svc, ...out, assets: svc.get("w", out.campaignId).assets };
  }

  it("records who rejected it and why, keeps the campaign an editable draft, and reports the latest approval state", async () => {
    const { svc, campaignId, approvalId, assets } = await drafted();
    expect(svc.get("w", campaignId).approval).toMatchObject({ id: approvalId, status: "pending", note: null });

    svc.decide("w", approvalId, "rejected", "hanan", "Tone is too salesy");
    const c = svc.get("w", campaignId);
    expect(c.status).toBe("draft");
    expect(c.approval).toMatchObject({ id: approvalId, status: "rejected", decidedBy: "hanan", note: "Tone is too salesy" });
    // still editable and reviewable afterwards
    expect(svc.editAsset("w", campaignId, assets[0].id, "A friendlier subject").status).toBe("draft");
    expect(svc.reviewAsset("w", campaignId, assets[0].id, "approved").status).toBe("approved");
  });

  it("lets you ask again after a rejection, and the new request can be approved", async () => {
    const { svc, campaignId, approvalId, assets } = await drafted();
    svc.decide("w", approvalId, "rejected", "hanan", "Needs a rewrite");
    svc.editAsset("w", campaignId, assets[0].id, "A friendlier subject");
    for (const a of assets) svc.reviewAsset("w", campaignId, a.id, "approved");

    const again = svc.requestApproval("w", campaignId);
    expect(again.approvalId).not.toBe(approvalId);
    expect(svc.get("w", campaignId).approval).toMatchObject({ id: again.approvalId, status: "pending", note: null });
    expect(svc.listApprovals("w", "pending").map((a) => a.id)).toEqual([again.approvalId]);
    expect(svc.listApprovals("w", "rejected")).toHaveLength(1); // the history keeps the rejection

    expect(svc.decide("w", again.approvalId, "approved", "hanan").status).toBe("approved");
    expect(svc.get("w", campaignId).status).toBe("approved");
  });

  it("can be rejected and re-requested more than once", async () => {
    const { svc, campaignId, approvalId } = await drafted();
    svc.decide("w", approvalId, "rejected", "h", "round 1");
    const second = svc.requestApproval("w", campaignId);
    svc.decide("w", second.approvalId, "rejected", "h", "round 2");
    const third = svc.requestApproval("w", campaignId);
    expect(svc.get("w", campaignId).approval).toMatchObject({ id: third.approvalId, status: "pending" });
    expect(svc.listApprovals("w", "rejected").map((a) => (a.payload as { note: string }).note).sort()).toEqual(["round 1", "round 2"]);
  });

  it("refuses to ask again while a request is open, for approved campaigns, or for other workspaces", async () => {
    const { svc, campaignId, approvalId, assets } = await drafted();
    expect(() => svc.requestApproval("w", campaignId)).toThrow(/already waiting/);
    expect(() => svc.requestApproval("other", campaignId)).toThrow(/not found/);

    for (const a of assets) svc.reviewAsset("w", campaignId, a.id, "approved");
    svc.decide("w", approvalId, "approved", "h");
    expect(() => svc.requestApproval("w", campaignId)).toThrow(/Only drafts/);
  });

  it("cannot send a campaign with no copy for approval", async () => {
    const { svc, campaignId, approvalId } = await drafted();
    svc.decide("w", approvalId, "rejected", "h");
    db.delete(schema.campaignAssets).where(eq(schema.campaignAssets.campaignId, campaignId)).run();
    expect(() => svc.requestApproval("w", campaignId)).toThrow(/no copy/);
  });
});

describe("campaign performance", () => {
  const metric = (campaignId: string, date: string, over: Record<string, number> = {}) => ({
    workspaceId: "w", campaignId, channel: "meta_ads", date, impressions: 1000, clicks: 100, spend: 50, conversions: 5, revenue: 200, ingestedAt: "x", ...over,
  });
  const day = (n: number) => new Date(Date.parse("2026-03-14") - n * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    db.insert(schema.campaigns).values([
      { id: "p1", workspaceId: "w", name: "Meta Spring", channel: "meta_ads", status: "active", source: "meta_ads" },
      { id: "p2", workspaceId: "other", name: "Theirs", channel: "meta_ads", status: "active", source: "seed" },
    ]).run();
  });

  it("works for campaigns that were not drafted here (no brief or plan) and compares with the previous window", () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(metric("p1", day(i), { conversions: 10, revenue: 400 })); // latest 3 days of the window + earlier
    for (let i = 6; i < 12; i++) rows.push(metric("p1", day(i)));
    db.insert(schema.campaignMetrics).values(rows).run();
    const { svc } = make({});
    const p = svc.performance("w", "p1", 6);
    expect(p.campaign).toMatchObject({ name: "Meta Spring", source: "meta_ads" });
    expect(p.range).toEqual({ startDate: day(5), endDate: day(0) });
    expect(p.previousRange).toEqual({ startDate: day(11), endDate: day(6) });
    expect(p.daily.map((d) => d.date)).toEqual([day(5), day(4), day(3), day(2), day(1), day(0)]);
    expect(p.totals).toMatchObject({ conversions: 60, revenue: 2400, spend: 300, daysWithData: 6 });
    expect(p.totals!.roas).toBeCloseTo(8);
    expect(p.previousTotals).toMatchObject({ conversions: 30, revenue: 1200 });
  });

  it("anchors on the latest day with data, so a stale feed still shows something", () => {
    db.insert(schema.campaignMetrics).values([metric("p1", "2026-01-05")]).run();
    expect(make({}).svc.performance("w", "p1", 7).latestDate).toBe("2026-01-05");
  });

  it("returns an empty shape (not an error) when there is no data, and null comparison with no earlier data", () => {
    const { svc } = make({});
    expect(svc.performance("w", "p1")).toMatchObject({ latestDate: null, daily: [], totals: null, previousTotals: null });
    db.insert(schema.campaignMetrics).values([metric("p1", day(0))]).run();
    expect(svc.performance("w", "p1", 7).previousTotals).toBeNull();
  });

  it("is workspace-scoped", () => {
    db.insert(schema.campaignMetrics).values([metric("p2", day(0))]).run();
    expect(() => make({}).svc.performance("w", "p2")).toThrow(/not found/);
  });
});

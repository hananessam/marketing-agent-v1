import type { CampaignBrief, CampaignPlan } from "@marketing/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { RunsService } from "../runs/runs.service";
import { createTestDb, schema } from "../test/helpers";
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
  return { svc: new CampaignsService(db, tools, runs, full), calls };
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

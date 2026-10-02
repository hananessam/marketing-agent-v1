import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsService } from "../actions/actions.service";
import { CampaignsService } from "../campaigns/campaigns.service";
import type { Db } from "../db";
import { createTestDb, schema } from "../test/helpers";
import { executionMode } from "./mode";
import { PublishingRouter } from "./publishing.router";
import { PublishingService } from "./publishing.service";
import { SandboxPublisher } from "./sandbox-publisher";

let db: Db;
let real: PublishingService;
let router: PublishingRouter;
let actions: ActionsService;
let inbox: CampaignsService;

const META = { dailyBudget: 10, country: "US", pageId: "1000000000001", landingUrl: "https://acme.com/start" };
const propose = (payload: unknown) => actions.propose("w", { type: "publish_campaign", payload, source: "campaign", requestedBy: "tester" } as never);
const approveLatest = async () => (await inbox.decideApproval("w", db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).all()[0].id, "approved", "me")) as { action: { status: string; result: unknown } };

beforeEach(async () => {
  delete process.env.EXECUTION_MODE;
  db = await createTestDb();
  real = new PublishingService(db, () => { throw new Error("the real Meta must never be reached in demo mode"); });
  const publishSpy = vi.spyOn(real, "publish");
  router = new PublishingRouter(real, new SandboxPublisher(db));
  actions = new ActionsService(db, router);
  inbox = new CampaignsService(db, {} as never, {} as never, {} as never, actions);
  db.insert(schema.workspaces).values({ id: "w", name: "w" }).run();
  db.insert(schema.brandProfiles).values({ id: "bp", workspaceId: "w", voice: "v", approvedClaims: [], prohibited: [], allowedDomains: ["acme.com"] }).run();
  db.insert(schema.campaigns).values([
    { id: "ready", workspaceId: "w", name: "Launch Me", channel: "google_ads,meta_ads", status: "approved", source: "manual" },
    { id: "googleonly", workspaceId: "w", name: "Search Only", channel: "google_ads", status: "approved", source: "manual" },
  ]).run();
  const a = (id: string, campaignId: string, variant: string, kind: string, content: string) => ({ id, workspaceId: "w", campaignId, variant, kind, content, status: "approved" as const });
  db.insert(schema.campaignAssets).values([
    a("g1", "ready", "google_ads:A", "ad_headline", "Plan your week"),
    a("m1", "ready", "meta_ads:A", "ad_headline", "Plan faster"), a("m5", "ready", "meta_ads:B", "ad_headline", "Ship sooner"),
    a("g2", "googleonly", "google_ads:A", "ad_headline", "Search me"),
  ]).run();
  void publishSpy;
  db.insert(schema.campaigns).values([
    { id: "run", workspaceId: "w", name: "Running Ads", channel: "meta_ads", status: "active", source: "meta_ads" },
    { id: "quiet", workspaceId: "w", name: "No Spend Yet", channel: "meta_ads", status: "active", source: "meta_ads" },
  ]).run();
  db.insert(schema.campaignMetrics).values(["2026-09-30", "2026-10-01"].map((date, i) => ({ workspaceId: "w", campaignId: "run", channel: "meta_ads", date, impressions: 1000, clicks: 50, spend: 20 + i * 10, conversions: 2, revenue: 100, ingestedAt: "x" }))).run();
});
afterEach(() => { delete process.env.EXECUTION_MODE; vi.restoreAllMocks(); });

describe("the mode", () => {
  it("is demo unless the server says live or shadow", () => {
    expect(executionMode()).toBe("demo");
    for (const [v, want] of [["live", "live"], ["LIVE", "live"], ["shadow", "shadow"], ["", "demo"], ["nonsense", "demo"]] as const) {
      process.env.EXECUTION_MODE = v;
      expect(executionMode()).toBe(want);
    }
  });
});

describe("demo mode (the default): approving posts to the ads sandbox", () => {
  it("reports a ready-to-post demo account without any connection", () => {
    expect(router.status("w")).toMatchObject({ mode: "demo", meta: { connected: true, canPublish: true, missing: [] }, google: { available: true } });
    expect(router.metaDetails("w")).toMatchObject({ accountActive: true, pages: [{ id: "1000000000001" }, { id: "1000000000002" }] });
  });

  it("creates paused demo ads on both platforms and never reaches the real Meta", async () => {
    const r = await propose({ campaignId: "ready", meta: META });
    expect(r.action.status).toBe("awaiting_approval");
    expect(r.action.approvalId).toBeTruthy();
    expect(r.action.preview.summary).toContain("demo sandbox");
    const out = await approveLatest();
    expect(out.action.status).toBe("executed");
    const platforms = (out.action.result as any).platforms;
    expect((out.action.result as any).mode).toBe("demo");
    expect(platforms.meta_ads).toMatchObject({ outcome: "created_paused", sandbox: true, adsManagerUrl: null, dailyBudgetMinor: 1000, currency: "USD" });
    expect(platforms.meta_ads.ads.map((x: any) => x.headline)).toEqual(["Plan faster", "Ship sooner"]);
    expect(platforms.meta_ads.adIds.every((x: string) => x.startsWith("sbx_ad_"))).toBe(true);
    expect(platforms.google_ads).toMatchObject({ outcome: "created_paused", sandbox: true });
  });

  it("returns what an ad account would hold: campaign, ad set, page and each ad with its copy and tracked link", async () => {
    db.insert(schema.campaignAssets).values([
      { id: "d1", workspaceId: "w", campaignId: "ready", kind: "ad_description", variant: "meta_ads:A", content: "Free trial", status: "approved" },
      { id: "d2", workspaceId: "w", campaignId: "ready", kind: "social_post", variant: "meta_ads:A", content: "Plan projects with Acme", status: "approved" },
      { id: "d3", workspaceId: "w", campaignId: "ready", kind: "cta", variant: "meta_ads:A", content: "Start free trial", status: "approved" },
      { id: "d4", workspaceId: "w", campaignId: "ready", kind: "ad_description", variant: "google_ads:A", content: "Simple planning", status: "approved" },
    ]).run();
    await propose({ campaignId: "ready", meta: META });
    const r = ((await approveLatest()).action.result as any).platforms;
    expect(r.meta_ads.campaign).toMatchObject({ name: "Launch Me (Marketing Agent)", objective: "Traffic", status: "PAUSED" });
    expect(r.meta_ads.adSet).toMatchObject({ name: "Launch Me · US", dailyBudgetMinor: 1000, currency: "USD", country: "US", optimizedFor: "Link clicks", status: "PAUSED" });
    expect(r.meta_ads.page).toEqual({ id: "1000000000001", name: "Demo Page" });
    expect(r.meta_ads.campaignId).toBe(r.meta_ads.campaign.id);
    const ad = r.meta_ads.ads.find((a: any) => a.headline === "Plan faster");
    expect(ad).toMatchObject({ description: "Free trial", primaryText: "Plan projects with Acme", cta: "Start free trial" });
    const link = new URL(ad.link);
    expect(link.origin + link.pathname).toBe("https://acme.com/start");
    expect(link.searchParams.get("utm_content")).toBe("a");
    expect(link.searchParams.get("utm_source")).toBe("meta");
    expect(r.google_ads.campaign).toMatchObject({ type: "Search", status: "PAUSED" });
    expect(r.google_ads.ads[0]).toMatchObject({ headline: "Plan your week", description: "Simple planning" });
    expect(r.google_ads.ads[0]).not.toHaveProperty("link"); // search ads have no landing page to set up here
  });

  it("posts Google-only copy with no ad settings at all", async () => {
    await propose({ campaignId: "googleonly" });
    const out = await approveLatest();
    expect(out.action.status).toBe("executed");
    expect((out.action.result as any).platforms.google_ads.ads).toHaveLength(1);
    expect((out.action.result as any).platforms.meta_ads).toBeUndefined();
  });

  it("applies the same rules as a real platform and refuses a bad request before anything is created", async () => {
    await expect(propose({ campaignId: "ready" })).rejects.toThrow(/daily budget, a country/);
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 0.5 } })).rejects.toThrow(/at least 1/);
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 500 } })).rejects.toThrow(/limited to 50/);
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "http://acme.com" } })).rejects.toThrow(/https/);
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "https://evil.example" } })).rejects.toThrow(/your own websites/);
    await expect(propose({ campaignId: "ready", meta: { ...META, pageId: "5555555555" } })).rejects.toThrow(/demo Pages/);
    expect(db.select().from(schema.actions).all()).toHaveLength(0);
  });

  it("does not post the same campaign twice", async () => {
    await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 20 } })).rejects.toThrow(/already been posted/);
  });
});

describe("live mode still goes to the real service", () => {
  it("routes status and publishing to PublishingService, untouched", () => {
    process.env.EXECUTION_MODE = "live";
    expect(router.status("w")).toMatchObject({ mode: "live", meta: { connected: false, canPublish: false }, google: { available: false } });
    expect(() => router.preflight("w", "ready", META)).toThrow(/Connect your Meta Ads account/);
  });
});

const act = (type: string, payload: unknown) => actions.propose("w", { type, payload, source: "manual", requestedBy: "tester" } as never);
const campaign = (id: string) => db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get()!;

describe("demo mode: pause and budget changes are simulated in the sandbox", () => {
  it("pauses the campaign after approval, and not before", async () => {
    const r = await act("pause_campaign", { campaignId: "run", reason: "wasting spend" });
    expect(r.action.status).toBe("awaiting_approval");
    expect(campaign("run").status).toBe("active");
    const out = await approveLatest();
    expect(out.action.status).toBe("executed");
    expect(out.action.result).toMatchObject({ mode: "demo", sandbox: true, outcome: "paused", from: "active", to: "paused" });
    expect(campaign("run").status).toBe("paused");
    await expect(act("pause_campaign", { campaignId: "run" })).rejects.toThrow(/already paused/);
  });

  it("changes the budget starting from the recent average spend, and later changes build on the last one", async () => {
    await act("change_budget", { campaignId: "run", direction: "increase", percent: 10 });
    const first = await approveLatest();
    expect(first.action.result).toMatchObject({ outcome: "budget_changed", from: 25, to: 27.5, currency: "USD" });
    await act("change_budget", { campaignId: "run", direction: "decrease", percent: 10 });
    const second = await approveLatest();
    expect(second.action.result).toMatchObject({ from: 27.5, to: 24.75 });
  });

  it("starts from the budget a campaign was posted with", async () => {
    await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    await act("change_budget", { campaignId: "ready", direction: "increase", percent: 10 });
    expect((await approveLatest()).action.result).toMatchObject({ from: 10, to: 11 });
  });

  it("fails clearly, changing nothing, when there is no budget to start from or the limits are hit", async () => {
    await act("change_budget", { campaignId: "quiet", direction: "increase", percent: 5 });
    const none = await approveLatest();
    expect(none.action.status).toBe("failed");
    expect((none.action.result as any).error).toMatch(/no budget to change/);
  });

  it("keeps the sandbox budget between 1 and 50 USD", async () => {
    db.insert(schema.campaigns).values([
      { id: "big", workspaceId: "w", name: "Big", channel: "meta_ads", status: "active", source: "meta_ads" },
      { id: "tiny", workspaceId: "w", name: "Tiny", channel: "meta_ads", status: "active", source: "meta_ads" },
    ]).run();
    const spend = (campaignId: string, v: number) => ({ workspaceId: "w", campaignId, channel: "meta_ads", date: "2026-10-01", impressions: 1, clicks: 1, spend: v, conversions: 0, revenue: 0, ingestedAt: "x" });
    db.insert(schema.campaignMetrics).values([spend("big", 48), spend("tiny", 1.05)]).run();
    await act("change_budget", { campaignId: "big", direction: "increase", percent: 10 });
    const high = await approveLatest();
    expect(high.action.status).toBe("failed");
    expect((high.action.result as any).error).toMatch(/limited to 50/);
    await act("change_budget", { campaignId: "tiny", direction: "decrease", percent: 10 });
    const low = await approveLatest();
    expect(low.action.status).toBe("failed");
    expect((low.action.result as any).error).toMatch(/below 1/);
  });

  it("leaves live and shadow behaviour alone: nothing is simulated there", async () => {
    process.env.EXECUTION_MODE = "shadow";
    await act("pause_campaign", { campaignId: "run" });
    const out = await approveLatest();
    expect(out.action.status).toBe("shadowed");
    expect(campaign("run").status).toBe("active");
  });
});

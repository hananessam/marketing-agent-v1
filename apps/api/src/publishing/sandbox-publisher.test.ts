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

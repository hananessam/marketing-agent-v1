import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionsService } from "../actions/actions.service";
import { CampaignsService } from "../campaigns/campaigns.service";
import { encryptSecret } from "../connectors/crypto";
import type { Db } from "../db";
import { createTestDb, schema } from "../test/helpers";
import type { MetaPublisher } from "./meta-publisher";
import { PublishingService, REQUIRED_PERMISSIONS } from "./publishing.service";

beforeAll(() => { process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64"); });

class FakePublisher {
  published: Record<string, any>[] = [];
  account = async (): Promise<{ name: string; currency: string; active: boolean; minDailyBudget: number | null }> => ({ name: "Acct", currency: "USD", active: true, minDailyBudget: null });
  pages = async () => [{ id: "111222333", name: "Acme" }];
  publish = async (args: Record<string, any>) => {
    this.published.push(args);
    return { campaignId: "c1", adSetId: "s1", creativeIds: ["cr1", "cr2"], adIds: ["ad1", "ad2"], dailyBudgetMinor: 2500, currency: "USD", adsManagerUrl: "https://adsmanager.facebook.com/x", status: "PAUSED" as const };
  };
}

let db: Db;
let fake: FakePublisher;
let factoryArgs: [string, string][];
let publishing: PublishingService;
let actions: ActionsService;
let inbox: CampaignsService;

const META = { dailyBudget: 25, country: "US", pageId: "111222333", landingUrl: "https://acme.com/start" };
const propose = (payload: unknown, ws = "w") => actions.propose(ws, { type: "publish_campaign", payload, source: "campaign", requestedBy: "tester" } as never);
const pending = () => db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).all();
const approveLatest = async () => inbox.decideApproval("w", pending()[0].id, "approved", "me");
const connection = () => db.select().from(schema.connections).get()!;
const setPermissions = (permissions: string) => db.update(schema.connections).set({ config: { ...connection().config, permissions } }).run();

beforeEach(async () => {
  delete process.env.EXECUTION_MODE; delete process.env.MAX_DAILY_BUDGET;
  db = await createTestDb();
  fake = new FakePublisher();
  factoryArgs = [];
  publishing = new PublishingService(db, (token, acct) => { factoryArgs.push([token, acct]); return fake as unknown as MetaPublisher; });
  actions = new ActionsService(db, publishing);
  inbox = new CampaignsService(db, {} as never, {} as never, {} as never, actions);

  db.insert(schema.workspaces).values([{ id: "w", name: "w" }, { id: "other", name: "o" }]).run();
  db.insert(schema.brandProfiles).values({ id: "bp", workspaceId: "w", voice: "v", approvedClaims: [], prohibited: [], allowedDomains: ["acme.com"] }).run();
  db.insert(schema.campaigns).values([
    { id: "ready", workspaceId: "w", name: "Launch Me", channel: "google_ads,meta_ads", status: "approved", source: "manual" },
    { id: "googleonly", workspaceId: "w", name: "Search Only", channel: "google_ads", status: "approved", source: "manual" },
  ]).run();
  const a = (id: string, campaignId: string, variant: string, kind: string, content: string) => ({ id, workspaceId: "w", campaignId, variant, kind, content, status: "approved" as const });
  db.insert(schema.campaignAssets).values([
    a("g1", "ready", "google_ads:A", "ad_headline", "Plan your week"),
    a("m1", "ready", "meta_ads:A", "ad_headline", "Plan faster"), a("m2", "ready", "meta_ads:A", "ad_description", "Free trial"),
    a("m3", "ready", "meta_ads:A", "social_post", "Plan projects with Acme"), a("m4", "ready", "meta_ads:A", "cta", "Start free trial"),
    a("m5", "ready", "meta_ads:B", "ad_headline", "Ship sooner"), a("m6", "ready", "meta_ads:B", "ad_description", "Set up fast"), a("m7", "ready", "meta_ads:B", "cta", "Learn more"),
    a("g2", "googleonly", "google_ads:A", "ad_headline", "Search me"),
  ]).run();
  db.insert(schema.connections).values({
    id: "conn", workspaceId: "w", provider: "meta_ads", accountId: "act_999", status: "ok",
    encryptedSecret: encryptSecret({ accessToken: "TOK" }), config: { accountName: "Acct", permissions: ["ads_read", ...REQUIRED_PERMISSIONS].join(",") },
  }).run();
});
afterEach(() => { delete process.env.EXECUTION_MODE; delete process.env.MAX_DAILY_BUDGET; });

describe("status", () => {
  it("reports what is connected and exactly which permissions are missing", () => {
    expect(publishing.status("other").meta).toMatchObject({ connected: false, canPublish: false });
    setPermissions("ads_read");
    expect(publishing.status("w").meta).toMatchObject({ connected: true, canPublish: false, missing: ["ads_management", "pages_show_list", "pages_read_engagement"] });
    setPermissions(["ads_read", ...REQUIRED_PERMISSIONS].join(","));
    expect(publishing.status("w")).toMatchObject({ mode: "shadow", maxDailyBudget: 50, meta: { canPublish: true, accountName: "Acct", missing: [] }, google: { available: false } });
    process.env.EXECUTION_MODE = "live";
    process.env.MAX_DAILY_BUDGET = "120";
    expect(publishing.status("w")).toMatchObject({ mode: "live", maxDailyBudget: 120 });
    process.env.MAX_DAILY_BUDGET = "nonsense";
    expect(publishing.status("w").maxDailyBudget).toBe(50); // a bad value falls back to the safe default
  });

  it("only reads the Meta details (currency, Pages) once posting is allowed", async () => {
    expect(await publishing.metaDetails("other")).toMatchObject({ pages: [], currency: null });
    setPermissions("ads_read");
    expect((await publishing.metaDetails("w")).pages).toEqual([]);
    expect(factoryArgs).toHaveLength(0);
    setPermissions(["ads_read", ...REQUIRED_PERMISSIONS].join(","));
    expect(await publishing.metaDetails("w")).toMatchObject({ currency: "USD", accountActive: true, pages: [{ id: "111222333", name: "Acme" }] });
  });
});

describe("refusals (live mode)", () => {
  beforeEach(() => { process.env.EXECUTION_MODE = "live"; });

  it("needs the ad settings, a connection, and the permissions, with instructions for each", async () => {
    await expect(propose({ campaignId: "ready" })).rejects.toThrow(/enter a daily budget/);
    await expect(propose({ campaignId: "ready", meta: META }, "other")).rejects.toThrow(/Campaign not found/); // other workspace cannot even see it
    setPermissions("ads_read");
    await expect(propose({ campaignId: "ready", meta: META })).rejects.toThrow(/Allow posting.*ads_management/);
    db.delete(schema.connections).run();
    await expect(propose({ campaignId: "ready", meta: META })).rejects.toThrow(/Connect your Meta Ads account/);
    expect(pending()).toHaveLength(0);
  });

  it("enforces the daily budget ceiling, however it is entered", async () => {
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 51 } })).rejects.toThrow(/limited to 50.*MAX_DAILY_BUDGET/);
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 0 } })).rejects.toMatchObject({ status: 400 });
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: -5 } })).rejects.toMatchObject({ status: 400 });
    process.env.MAX_DAILY_BUDGET = "200";
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 150 } })).resolves.toBeTruthy();
  });

  it("only links to the company's own websites, over https", async () => {
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "https://evil.example/x" } })).rejects.toThrow(/your own websites/);
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "https://notacme.com/x" } })).rejects.toThrow(/your own websites/);
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "http://acme.com/x" } })).rejects.toThrow(/https/);
    await expect(propose({ campaignId: "ready", meta: { ...META, landingUrl: "https://shop.acme.com/x" } })).resolves.toBeTruthy(); // subdomains are covered
  });

  it("validates the country and the Page id shape", async () => {
    await expect(propose({ campaignId: "ready", meta: { ...META, country: "usa" } })).rejects.toMatchObject({ status: 400 });
    await expect(propose({ campaignId: "ready", meta: { ...META, pageId: "not-a-number" } })).rejects.toMatchObject({ status: 400 });
  });
});

describe("the ad account's own budget limits (a real EGP account rejected a budget under 52.43)", () => {
  beforeEach(() => { process.env.EXECUTION_MODE = "live"; });
  const knowMinimum = (min: string, currency = "EGP") => db.update(schema.connections).set({ config: { ...connection().config, minDailyBudget: min, currency } }).run();

  it("learns the account's currency and minimum when the form loads, and then enforces them without calling Meta", async () => {
    fake.account = async () => ({ name: "Acct", currency: "EGP", active: true, minDailyBudget: 52.43 });
    const d = await publishing.metaDetails("w");
    expect(d).toMatchObject({ currency: "EGP", minDailyBudget: 52.43, maxDailyBudget: 2621.5 }); // ceiling defaults to 50x the minimum (about 50 USD)
    expect(connection().config).toMatchObject({ currency: "EGP", minDailyBudget: "52.43" });
    expect(publishing.status("w")).toMatchObject({ currency: "EGP", minDailyBudget: 52.43 });
  });

  it("refuses a budget at or under the minimum before anything is created, with the account's own numbers", async () => {
    knowMinimum("52.43");
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 50 } })).rejects.toThrow(/more than 52.43 EGP/);
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 52.43 } })).rejects.toThrow(/more than 52.43 EGP/); // Meta needs strictly more
    expect(pending()).toHaveLength(0);
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 53 } })).resolves.toBeTruthy();
  });

  it("scales the default ceiling to the currency, so a valid budget is never above it", async () => {
    knowMinimum("52.43");
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 2000 } })).resolves.toBeTruthy(); // fine in EGP; would be far above 50 in a USD-sized ceiling
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 3000 } })).rejects.toThrow(/limited to 2621.5 EGP/);
    process.env.MAX_DAILY_BUDGET = "100";
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 99 } })).resolves.toBeTruthy(); // an explicit setting always wins
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 101 } })).rejects.toThrow(/limited to 100 EGP/);
  });

  it("checks Meta's current minimum again when it runs, so a stale or missing cache cannot let a bad budget through", async () => {
    const r = await propose({ campaignId: "ready", meta: { ...META, dailyBudget: 20 } }); // nothing cached yet, so it is accepted
    fake.account = async () => ({ name: "Acct", currency: "EGP", active: true, minDailyBudget: 52.43 });
    await approveLatest();
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "failed", result: { error: expect.stringContaining("more than 52.43 EGP") } });
    expect(fake.published).toHaveLength(0); // nothing was created, so nothing needed cleaning up
  });
});

describe("approving posts to Meta (paused) in live mode", () => {
  beforeEach(() => { process.env.EXECUTION_MODE = "live"; });

  it("creates the paused ads from each variant's own copy, notes Google as not posted, and remembers the settings", async () => {
    const r = await propose({ campaignId: "ready", meta: META });
    expect(r.action.status).toBe("awaiting_approval");
    expect(r.action.preview.summary).toContain("Meta: 25 per day in US, created PAUSED");
    expect(fake.published).toHaveLength(0); // nothing happens before approval

    await approveLatest();
    const done = actions.get("w", r.action.id);
    expect(done.status).toBe("executed");
    const platforms = (done.result as { platforms: Record<string, any> }).platforms;
    expect(platforms.meta_ads).toMatchObject({ outcome: "created_paused", status: "PAUSED", campaignId: "c1", adIds: ["ad1", "ad2"] });
    expect(platforms.google_ads).toMatchObject({ outcome: "not_posted" });
    expect(platforms.google_ads.note).toMatch(/not connected yet/);

    expect(factoryArgs).toEqual([["TOK", "act_999"]]); // the stored token, for the right ad account
    expect(fake.published).toHaveLength(1);
    const call = fake.published[0];
    expect(call).toMatchObject({ campaignName: "Launch Me", currency: "USD", settings: META });
    expect(call.ads).toEqual([
      { name: "Launch Me · Ad A", headline: "Plan faster", description: "Free trial", primaryText: "Plan projects with Acme", cta: "Start free trial", contentLabel: "A" },
      { name: "Launch Me · Ad B", headline: "Ship sooner", description: "Set up fast", primaryText: "Set up fast", cta: "Learn more", contentLabel: "B" }, // no post text: falls back to the description
    ]);
    expect(JSON.parse(connection().config.publishDefaults)).toEqual(META);
    expect(publishing.status("w").meta.defaults).toEqual(META);
    expect(actions.latestPublish("w", "ready")).toMatchObject({ id: r.action.id, status: "executed" });
  });

  it("asking again after a successful post is refused, and nothing is posted twice", async () => {
    await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    await expect(propose({ campaignId: "ready", meta: META })).rejects.toThrow(/already been posted to Meta/);
    expect(fake.published).toHaveLength(1);
    expect(actions.list("w", "awaiting_approval")).toHaveLength(0); // no second request was even created
  });

  it("identical requests are one request, wherever they came from", async () => {
    const a = await actions.propose("w", { type: "publish_campaign", payload: { campaignId: "ready", meta: META }, source: "campaign", sourceRef: "ready", requestedBy: "dashboard" } as never);
    const b = await actions.propose("w", { type: "publish_campaign", payload: { campaignId: "ready", meta: META }, source: "manual", requestedBy: "someone else" } as never);
    expect(b.reused).toBe(true);
    expect(b.action.id).toBe(a.action.id);
    expect(pending()).toHaveLength(1);
  });

  it("a campaign that has really been posted cannot be posted again, even with different settings or a request already waiting", async () => {
    await propose({ campaignId: "ready", meta: META });
    const waiting = await propose({ campaignId: "ready", meta: { ...META, dailyBudget: 30 } }); // a second, different request is waiting
    expect(pending()).toHaveLength(2);
    await inbox.decideApproval("w", pending().find((p) => (p.payload as any).actionId !== waiting.action.id)!.id, "approved", "me");
    expect(fake.published).toHaveLength(1);

    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 20 } })).rejects.toThrow(/already been posted to Meta/); // refused up front
    await inbox.decideApproval("w", pending()[0].id, "approved", "me"); // the one that was already waiting is refused when it runs
    expect(actions.get("w", waiting.action.id)).toMatchObject({ status: "failed", result: { error: expect.stringContaining("already been posted") } });
    expect(fake.published).toHaveLength(1); // never a second set of ads
  });

  it("a campaign with only Google copy needs no Meta settings and posts nothing", async () => {
    const r = await propose({ campaignId: "googleonly" });
    await approveLatest();
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "shadowed", result: { platforms: { google_ads: { outcome: "not_posted" } } } });
    expect(fake.published).toHaveLength(0);
  });

  it("records a failed post with a readable reason, leaves no defaults behind, and allows a retry", async () => {
    fake.publish = async () => { throw new Error("That Page cannot be used"); };
    const r = await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "failed", result: { error: "That Page cannot be used" } });
    expect(connection().config.publishDefaults).toBeUndefined();
    expect(JSON.stringify(actions.get("w", r.action.id))).not.toContain("TOK");
    fake.publish = new FakePublisher().publish;
    expect((await propose({ campaignId: "ready", meta: META })).reused).toBe(false); // failed actions free their key
  });

  it("refuses an inactive ad account and a Page this login does not manage, before creating anything", async () => {
    fake.account = async () => ({ name: "Acct", currency: "USD", active: false, minDailyBudget: null });
    await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    expect(actions.list("w")[0]).toMatchObject({ status: "failed", result: { error: expect.stringContaining("not active") } });

    fake.account = async () => ({ name: "Acct", currency: "USD", active: true, minDailyBudget: null });
    await propose({ campaignId: "ready", meta: { ...META, pageId: "999888777" } });
    await approveLatest();
    expect(actions.list("w")[0]).toMatchObject({ status: "failed", result: { error: expect.stringContaining("not one this login can post as") } });
    expect(fake.published).toHaveLength(0);
  });

  it("re-checks permissions when the approval executes, not just when it was proposed", async () => {
    const r = await propose({ campaignId: "ready", meta: META });
    setPermissions("ads_read"); // revoked in the meantime
    await approveLatest();
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "failed" });
    expect(fake.published).toHaveLength(0);
  });
});

describe("shadow mode", () => {
  beforeEach(() => { process.env.EXECUTION_MODE = "shadow"; });
  it("records what would happen and never calls Meta, even with everything connected", async () => {
    const r = await propose({ campaignId: "ready", meta: META });
    await approveLatest();
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "shadowed", result: { mode: "shadow", note: "Nothing outside this app was changed." } });
    expect(fake.published).toHaveLength(0);
    expect(factoryArgs).toHaveLength(0);
  });

  it("does not require ad settings, but still rejects an over-budget request", async () => {
    await expect(propose({ campaignId: "ready" })).resolves.toBeTruthy();
    await expect(propose({ campaignId: "ready", meta: { ...META, dailyBudget: 500 } })).rejects.toThrow(/limited to 50/);
  });
});

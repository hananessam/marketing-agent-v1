import { describe, expect, it } from "vitest";
import { ConnectorAuthError } from "../connectors/http";
import { ctaTypeFor, MetaPublisher, MetaPublishError, toMinorUnits, withTracking, type MetaAdInput, type MetaPublishSettings } from "./meta-publisher";

type Call = { method: string; path: string; params: Record<string, string>; headers: Record<string, string>; url: string };

/** A tiny fake of the Graph API that records every request and can be told to misbehave. */
function fakeGraph(opts: { failOn?: (c: Call, n: number) => { status: number; body: unknown } | undefined; statusOf?: (id: string) => string | undefined } = {}) {
  const calls: Call[] = [];
  const objects = new Map<string, { kind: string; status: string }>();
  let seq = 99; // first created object is 100: campaign 100, ad set 101, then creative/ad pairs
  const creates = new Map<string, number>();
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, "");
    const method = (init.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(method === "GET" ? u.searchParams : new URLSearchParams(init.body as URLSearchParams));
    const call: Call = { method, path, params, headers: init.headers as Record<string, string>, url };
    calls.push(call);
    const n = calls.filter((c) => c.method === method && c.path === path).length;
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response;

    const forced = opts.failOn?.(call, n);
    if (forced) return reply(forced.status, forced.body);

    const kind = path.split("/").pop()!;
    if (method === "POST" && ["campaigns", "adsets", "adcreatives", "ads"].includes(kind)) {
      const id = String(++seq);
      objects.set(id, { kind, status: params.status ?? "n/a" });
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      return reply(200, { id });
    }
    if (method === "POST") { const o = objects.get(path); if (o && params.status) o.status = params.status; return reply(200, { success: true }); }
    if (method === "DELETE") { objects.delete(path); return reply(200, { success: true }); }
    if (path === "me/accounts") {
      // two pages of results: the first links to a next page (with a token-bearing URL we must not follow), the second is the last
      if (params.after === "C") return reply(200, { data: [{ id: "222", name: "Second Page" }], paging: { cursors: { after: "D" } } });
      return reply(200, { data: [{ id: "111", name: "Acme Page" }, { id: "x", name: "bad" }], paging: { cursors: { after: "C" }, next: "https://leak?access_token=SECRET" } });
    }
    if (path.startsWith("act_")) return reply(200, { name: "My Account", currency: "usd", account_status: 1 });
    const o = objects.get(path);
    return reply(200, { id: path, status: opts.statusOf?.(path) ?? o?.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, objects, creates };
}

const settings: MetaPublishSettings = { dailyBudget: 25, country: "US", pageId: "111222333", landingUrl: "https://acme.com/start?ref=x" };
const ads: MetaAdInput[] = [
  { name: "Launch · A", headline: "Plan faster", description: "Free trial", primaryText: "Plan projects with Acme", cta: "Start Free Trial", contentLabel: "A" },
  { name: "Launch · B", headline: "Ship sooner", description: "Set up fast", primaryText: "Ship your product sooner", cta: "Learn more", contentLabel: "B" },
];
const noSleep = async () => {};
const make = (g: ReturnType<typeof fakeGraph>) => new MetaPublisher("TOKEN", "act_999", g.fetchFn, noSleep);
const run = (p: MetaPublisher, over: Partial<{ currency: string }> = {}) => p.publish({ campaignName: "Launch", ads, settings, currency: over.currency ?? "USD", utmCampaign: "Launch Me" });

describe("helpers", () => {
  it("converts budgets to the account's smallest unit", () => {
    expect(toMinorUnits(25, "USD")).toBe(2500);
    expect(toMinorUnits(12.34, "eur")).toBe(1234);
    expect(toMinorUnits(2500, "JPY")).toBe(2500); // zero-decimal currencies are not multiplied
    expect(toMinorUnits(19.999, "USD")).toBe(2000);
  });
  it("maps free-text button copy to Meta's fixed call-to-action list, defaulting to the safest", () => {
    expect(ctaTypeFor("Start Free Trial")).toBe("SIGN_UP");
    expect(ctaTypeFor("Shop the sale")).toBe("SHOP_NOW");
    expect(ctaTypeFor("Get a quote")).toBe("GET_QUOTE");
    expect(ctaTypeFor("See how it works")).toBe("LEARN_MORE");
    expect(ctaTypeFor("")).toBe("LEARN_MORE");
  });
  it("adds tracking without clobbering the landing page's own parameters", () => {
    const u = new URL(withTracking("https://acme.com/start?ref=x&utm_source=newsletter", { campaign: "Launch Me!", content: "Version A" }));
    expect(Object.fromEntries(u.searchParams)).toEqual({ ref: "x", utm_source: "newsletter", utm_medium: "paid_social", utm_campaign: "launch-me", utm_content: "version-a" });
  });
});

describe("publishing to Meta", () => {
  it("creates a paused campaign, ad set and one ad per variant, verifies they are paused, and never puts the token in a URL or body", async () => {
    const g = fakeGraph();
    const r = await run(make(g));
    expect(r).toMatchObject({ status: "PAUSED", dailyBudgetMinor: 2500, currency: "USD" });
    expect(r.adIds).toHaveLength(2);
    expect(r.adsManagerUrl).toContain("act=999");
    expect(r.adsManagerUrl).toContain(`selected_campaign_ids=${r.campaignId}`);

    const posts = g.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["act_999/campaigns", "act_999/adsets", "act_999/adcreatives", "act_999/ads", "act_999/adcreatives", "act_999/ads"]);
    const [campaign, adSet, creative, ad] = posts;
    expect(campaign.params).toMatchObject({ objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" });
    expect(adSet.params).toMatchObject({ status: "PAUSED", daily_budget: "2500", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", campaign_id: r.campaignId });
    expect(JSON.parse(adSet.params.targeting)).toEqual({ geo_locations: { countries: ["US"] } });
    const spec = JSON.parse(creative.params.object_story_spec);
    expect(spec.page_id).toBe("111222333");
    expect(spec.link_data).toMatchObject({ message: "Plan projects with Acme", name: "Plan faster", description: "Free trial", call_to_action: { type: "SIGN_UP" } });
    const link = new URL(spec.link_data.link);
    expect(link.searchParams.get("utm_content")).toBe("a");
    expect(link.searchParams.get("utm_campaign")).toBe("launch-me");
    expect(spec.link_data.call_to_action.value.link).toBe(spec.link_data.link);
    expect(ad.params).toMatchObject({ status: "PAUSED", adset_id: r.adSetId });
    expect(JSON.parse(ad.params.creative)).toEqual({ creative_id: r.creativeIds[0] });

    for (const c of g.calls) {
      expect(c.headers.authorization).toBe("Bearer TOKEN");
      expect(c.url).not.toContain("TOKEN");
      expect(JSON.stringify(c.params)).not.toContain("TOKEN");
    }
    // each created object was read back to confirm it is paused
    expect(g.calls.filter((c) => c.method === "GET" && c.params.fields === "status")).toHaveLength(4);
  });

  it("uses the ad account's currency units for the budget", async () => {
    const g = fakeGraph();
    await new MetaPublisher("T", "act_1", g.fetchFn, noSleep).publish({ campaignName: "x", ads, settings: { ...settings, dailyBudget: 3000 }, currency: "JPY", utmCampaign: "x" });
    expect(g.calls.find((c) => c.path === "act_1/adsets")!.params.daily_budget).toBe("3000");
  });

  it("re-pauses anything Meta reports as not paused, and removes everything if it still won't stay paused", async () => {
    let seen = 0;
    const flaky = fakeGraph({ statusOf: (id) => (id === "101" && seen++ === 0 ? "ACTIVE" : undefined) }); // the ad set reads ACTIVE once
    await expect(run(make(flaky))).resolves.toMatchObject({ status: "PAUSED" });
    expect(flaky.calls.some((c) => c.method === "POST" && c.path === "101" && c.params.status === "PAUSED")).toBe(true);

    const stuck = fakeGraph({ statusOf: (id) => (id === "100" ? "ACTIVE" : undefined) }); // the campaign never pauses
    await expect(run(make(stuck))).rejects.toThrow(/did not keep 100 paused/);
    expect(stuck.calls.some((c) => c.method === "DELETE" && c.path === "100")).toBe(true);
    expect(stuck.objects.has("100")).toBe(false);
  });

  it("deletes everything it created if a later step fails, and stops creating more", async () => {
    const g = fakeGraph({ failOn: (c, n) => (c.method === "POST" && c.path === "act_999/adcreatives" && n === 2 ? { status: 400, body: { error: { code: 100, message: "Invalid page", error_user_msg: "That Page cannot be used" } } } : undefined) });
    await expect(run(make(g))).rejects.toThrow(/That Page cannot be used.*Nothing was left behind/);
    expect(g.creates.get("ads")).toBe(1); // the second ad was never created
    expect(g.objects.size).toBe(0); // ad, ad set, creatives and campaign: all deleted explicitly
    expect(g.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["103", "101", "102", "100"]); // children first
  });

  it("never retries a create after a server error (it might have succeeded), but does retry explicit rate-limit rejections", async () => {
    const boom = fakeGraph({ failOn: (c) => (c.method === "POST" && c.path === "act_999/adsets" ? { status: 500, body: {} } : undefined) });
    await expect(run(make(boom))).rejects.toThrow(MetaPublishError);
    expect(boom.calls.filter((c) => c.method === "POST" && c.path === "act_999/adsets")).toHaveLength(1);

    const limited = fakeGraph({ failOn: (c, n) => (c.method === "POST" && c.path === "act_999/campaigns" && n === 1 ? { status: 400, body: { error: { code: 17, message: "limit" } } } : undefined) });
    await expect(run(make(limited))).resolves.toMatchObject({ status: "PAUSED" });
    expect(limited.creates.get("campaigns")).toBe(1); // exactly one campaign despite the retry
  });

  it("reports unremovable leftovers by id so they can be deleted by hand", async () => {
    const g = fakeGraph({
      failOn: (c) => (c.method === "POST" && c.path === "act_999/ads" ? { status: 400, body: { error: { code: 100, message: "bad ad" } } }
        : c.method === "DELETE" ? { status: 400, body: { error: { code: 1, message: "cannot" } } } : undefined),
    });
    const err = await run(make(g)).catch((e) => e);
    expect(err).toBeInstanceOf(MetaPublishError);
    expect(err.message).toContain("Delete them in Ads Manager");
    expect(err.leftovers).toContain("100");
  });

  it("turns expired tokens and missing permissions into instructions", async () => {
    const dead = fakeGraph({ failOn: () => ({ status: 400, body: { error: { code: 190, message: "expired" } } }) });
    await expect(run(make(dead))).rejects.toBeInstanceOf(ConnectorAuthError);
    const noPerm = fakeGraph({ failOn: (c) => (c.method === "POST" ? { status: 403, body: { error: { code: 200, message: "Requires ads_management" } } } : undefined) });
    await expect(run(make(noPerm))).rejects.toThrow(/Allow posting/);
  });
});

describe("reading the account", () => {
  it("returns the account's name, currency (upper-cased) and whether it is active", async () => {
    expect(await make(fakeGraph()).account()).toEqual({ name: "My Account", currency: "USD", active: true });
  });
  it("lists Pages by cursor, drops malformed ids and never follows the token-bearing next link", async () => {
    const g = fakeGraph();
    expect(await make(g).pages()).toEqual([{ id: "111", name: "Acme Page" }, { id: "222", name: "Second Page" }]);
    expect(g.calls.find((c) => c.params.after === "C")).toBeTruthy(); // followed by cursor
    expect(g.calls.some((c) => c.url.includes("leak"))).toBe(false);
  });
});

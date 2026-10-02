import { ConnectorAuthError, ConnectorError, requestJson, type HttpResult } from "../connectors/http";
import { META_API_VERSION } from "../connectors/meta";

/** Graph error codes that mean "rejected before doing anything", so a retry cannot create a duplicate. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AUTH_CODES = new Set([190, 102]);
const PERMISSION_CODES = new Set([10, 200, 283, 3]);

/** Currencies whose smallest unit is the whole unit; all others are expressed in hundredths. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const toMinorUnits = (amount: number, currency: string) => Math.round(amount * (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100));

export type MetaPublishSettings = { dailyBudget: number; country: string; pageId: string; landingUrl: string };
export type MetaAdInput = { name: string; headline: string; description: string; primaryText: string; cta: string; contentLabel: string };
export type MetaPublishResult = {
  campaignId: string; adSetId: string; creativeIds: string[]; adIds: string[];
  dailyBudgetMinor: number; currency: string; adsManagerUrl: string; status: "PAUSED";
};

/** Meta's call-to-action is a fixed list, our button text is free text: map by meaning, default to the safest. */
export function ctaTypeFor(text: string): string {
  const t = text.toLowerCase();
  if (/sign ?up|register|join|trial|get started|start/.test(t)) return "SIGN_UP";
  if (/shop|buy|order/.test(t)) return "SHOP_NOW";
  if (/quote/.test(t)) return "GET_QUOTE";
  if (/download/.test(t)) return "DOWNLOAD";
  if (/apply/.test(t)) return "APPLY_NOW";
  if (/subscribe/.test(t)) return "SUBSCRIBE";
  if (/contact|talk|call|demo/.test(t)) return "CONTACT_US";
  if (/book|schedule/.test(t)) return "BOOK_NOW";
  return "LEARN_MORE";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "campaign";

/** Adds the tracking parameters every link must carry (this is what makes Google Analytics attribute the traffic). */
export function withTracking(url: string, utm: { campaign: string; content: string }): string {
  const u = new URL(url);
  if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "meta");
  if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "paid_social");
  if (!u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", slug(utm.campaign));
  u.searchParams.set("utm_content", slug(utm.content));
  return u.toString();
}

export class MetaPublishError extends ConnectorError {
  constructor(message: string, public readonly leftovers: string[] = []) { super(message); }
}

export class MetaPublisher {
  constructor(
    private readonly accessToken: string,
    private readonly adAccountId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  // ------------------------------------------------------------------ plumbing

  /** Token travels in a header, never the URL. Writes are never retried on ambiguous failures. */
  private async call(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}): Promise<any> {
    const base = `https://graph.facebook.com/${META_API_VERSION}/${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.accessToken}` };
    const init: RequestInit = { method, headers };
    let url = base;
    if (method === "GET") url = `${base}?${new URLSearchParams(params)}`;
    else if (method === "POST") { init.body = new URLSearchParams(params); }
    const res = await requestJson(url, init, { fetchFn: this.fetchFn, sleep: this.sleep, idempotent: method === "GET", retryIf: (r) => RATE_LIMIT_CODES.has(r.json?.error?.code) });
    if (!res.ok) throw this.error(res);
    return res.json;
  }

  private error(res: HttpResult): Error {
    const e = res.json?.error;
    const msg = e?.error_user_msg ?? e?.message ?? `HTTP ${res.status}`;
    if (AUTH_CODES.has(e?.code) || res.status === 401) return new ConnectorAuthError("Meta access expired. Please reconnect Meta in Settings.");
    if (PERMISSION_CODES.has(e?.code)) return new ConnectorError(`Meta refused because posting is not allowed for this login (${msg}). Use "Allow posting" in Settings.`, res.status);
    return new ConnectorError(`Meta error${e?.code ? ` ${e.code}` : ""}: ${msg}`, res.status);
  }

  // ------------------------------------------------------------------ read helpers

  /** `minDailyBudget` is in whole currency units (what a person types), or null if Meta does not say. */
  async account(): Promise<{ name: string; currency: string; active: boolean; minDailyBudget: number | null }> {
    const a = await this.call("GET", this.adAccountId, { fields: "name,currency,account_status,min_daily_budget" });
    const currency = String(a.currency ?? "USD").toUpperCase();
    const minor = Number(a.min_daily_budget);
    return {
      name: a.name ?? this.adAccountId, currency, active: a.account_status === 1,
      minDailyBudget: Number.isFinite(minor) && minor > 0 ? minor / toMinorUnits(1, currency) : null,
    };
  }

  /** The Facebook Pages this login can run ads for. */
  async pages(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let after: string | undefined;
    do {
      const r = await this.call("GET", "me/accounts", { fields: "id,name", limit: "100", ...(after ? { after } : {}) });
      for (const p of r.data ?? []) if (/^\d+$/.test(p.id ?? "")) out.push({ id: p.id, name: p.name ?? p.id });
      after = r.paging?.next ? r.paging?.cursors?.after : undefined; // never follow paging.next: it embeds the token
    } while (after);
    return out;
  }

  // ------------------------------------------------------------------ publishing

  /**
   * Creates 1 campaign, 1 ad set and one ad per variant, ALL PAUSED, then asks Meta to confirm each is paused.
   * If anything fails, what was created is deleted again.
   */
  async publish(args: { campaignName: string; ads: MetaAdInput[]; settings: MetaPublishSettings; currency: string; utmCampaign: string }): Promise<MetaPublishResult> {
    const { settings, ads, currency } = args;
    const minor = toMinorUnits(settings.dailyBudget, currency);
    const created: { campaign?: string; adSet?: string; creatives: string[]; ads: string[] } = { creatives: [], ads: [] };
    const act = this.adAccountId;
    const json = (v: unknown) => JSON.stringify(v);

    try {
      const campaign = await this.call("POST", `${act}/campaigns`, {
        name: `${args.campaignName} (Marketing Agent)`, objective: "OUTCOME_TRAFFIC", status: "PAUSED",
        special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false",
      });
      created.campaign = campaign.id;

      const adSet = await this.call("POST", `${act}/adsets`, {
        name: `${args.campaignName} · ${settings.country}`, campaign_id: campaign.id, status: "PAUSED",
        daily_budget: String(minor), billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        destination_type: "WEBSITE", targeting: json({ geo_locations: { countries: [settings.country] } }),
      });

      created.adSet = adSet.id;
      const adIds: string[] = [];
      for (const ad of ads) {
        const link = withTracking(settings.landingUrl, { campaign: args.utmCampaign, content: ad.contentLabel });
        const creative = await this.call("POST", `${act}/adcreatives`, {
          name: ad.name,
          object_story_spec: json({
            page_id: settings.pageId,
            link_data: { link, message: ad.primaryText, name: ad.headline, description: ad.description, call_to_action: { type: ctaTypeFor(ad.cta), value: { link } } },
          }),
        });
        created.creatives.push(creative.id);
        const made = await this.call("POST", `${act}/ads`, { name: ad.name, adset_id: adSet.id, creative: json({ creative_id: creative.id }), status: "PAUSED" });
        created.ads.push(made.id);
        adIds.push(made.id);
      }

      // Never trust that "status: PAUSED" in the request took effect: ask, and if not, pause it and ask again.
      for (const id of [campaign.id, adSet.id, ...adIds]) await this.ensurePaused(id);

      return {
        campaignId: campaign.id, adSetId: adSet.id, creativeIds: created.creatives, adIds, dailyBudgetMinor: minor, currency, status: "PAUSED",
        adsManagerUrl: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act.replace(/^act_/, "")}&selected_campaign_ids=${campaign.id}`,
      };
    } catch (e) {
      const leftovers = await this.cleanup(created);
      const msg = e instanceof Error ? e.message : "Unexpected error";
      if (e instanceof ConnectorAuthError) throw e;
      throw new MetaPublishError(`${msg}${leftovers.length ? ` Some items could not be removed automatically: ${leftovers.join(", ")}. Delete them in Ads Manager.` : " Nothing was left behind."}`, leftovers);
    }
  }

  private async ensurePaused(id: string) {
    let status = (await this.call("GET", id, { fields: "status" })).status;
    if (status !== "PAUSED") {
      await this.call("POST", id, { status: "PAUSED" });
      status = (await this.call("GET", id, { fields: "status" })).status;
    }
    if (status !== "PAUSED") throw new ConnectorError(`Meta did not keep ${id} paused (status ${status}), so it was removed for safety.`);
  }

  /**
   * Best effort, and explicit: it does not rely on Meta cascading a campaign's deletion to its ad set and ads.
   * Order: ads, ad set, creatives, campaign. Returns the ids that could not be removed.
   */
  private async cleanup(created: { campaign?: string; adSet?: string; creatives: string[]; ads: string[] }): Promise<string[]> {
    const left: string[] = [];
    const del = async (id: string) => { try { await this.call("DELETE", id); } catch { left.push(id); } };
    for (const id of [...created.ads].reverse()) await del(id);
    if (created.adSet) await del(created.adSet);
    for (const id of [...created.creatives].reverse()) await del(id);
    if (created.campaign) await del(created.campaign);
    return left;
  }
}

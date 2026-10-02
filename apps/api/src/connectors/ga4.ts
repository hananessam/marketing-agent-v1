import { googleAccessToken, type GoogleClient } from "./google-auth";
import { ConnectorAuthError, ConnectorError, requestJson, type HttpResult } from "./http";
import type { CampaignInfo, Channel, Connector, ConnectorResult, DateRange, MetricRow } from "./types";

const PAGE = 10_000;

export type Ga4Credentials = { propertyId: string; refreshToken: string } & GoogleClient;

export type Ga4Row = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };
export type Ga4Response = { rows?: Ga4Row[]; rowCount?: number };

/** Not real campaigns: GA4 labels for traffic without a campaign. */
const NOT_A_CAMPAIGN = new Set(["(not set)", "(direct)", "(organic)", "(referral)", "(none)", ""]);

const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsocial", "paid_social", "paid-social", "cpm", "social_paid"]);

/** Map GA4 source/medium to one of our channels, or null when it isn't one we track. */
export function channelFor(source: string, medium: string): Channel | null {
  const s = source.toLowerCase();
  const m = medium.toLowerCase();
  if (!PAID_MEDIUMS.has(m)) return null;
  if (/(facebook|instagram|meta|fb|ig)/.test(s)) return "meta_ads";
  if (s.includes("google")) return "google_ads";
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "unnamed";
const ymd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/**
 * GA4 has no impressions or spend, so: sessions → clicks, key events → conversions, totalRevenue → revenue.
 * Rows are summed per (campaign, channel, day) because one campaign can span several source/medium pairs.
 */
export function normalizeGa4(rows: Ga4Row[]): ConnectorResult {
  const campaigns = new Map<string, CampaignInfo>();
  const acc = new Map<string, MetricRow>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  for (const r of rows) {
    const [date, name, source, medium] = r.dimensionValues.map((d) => d.value);
    const [sessions, keyEvents, revenue] = r.metricValues.map((m) => Number(m.value));
    if (NOT_A_CAMPAIGN.has(name.toLowerCase())) { skip("no_campaign"); continue; }
    if (!/^\d{8}$/.test(date) || [sessions, keyEvents, revenue].some((v) => !Number.isFinite(v) || v < 0)) { skip("invalid_row"); continue; }
    const channel = channelFor(source, medium);
    if (!channel) { skip("unmapped_source_medium"); continue; }

    const id = `ga4_${slug(name)}_${channel}`;
    campaigns.set(id, { id, name: `${name} (GA4)`, channel, source: "ga4" });
    const key = `${id}|${date}`;
    const cur = acc.get(key) ?? { campaignId: id, date: ymd(date), impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 };
    cur.clicks += sessions; cur.conversions += keyEvents; cur.revenue += revenue;
    acc.set(key, cur);
  }
  return { campaigns: [...campaigns.values()], rows: [...acc.values()], skipped };
}

export class Ga4Connector implements Connector {
  readonly provider = "ga4" as const;
  constructor(private readonly creds: Ga4Credentials, private readonly fetchFn: typeof fetch = fetch, private readonly sleep?: (ms: number) => Promise<void>) {}

  async fetch(range: DateRange): Promise<ConnectorResult> {
    const token = await googleAccessToken(this.creds, this.creds.refreshToken, this.fetchFn, this.sleep);
    const property = this.creds.propertyId.replace(/^properties\//, "");
    if (!/^\d+$/.test(property)) throw new Error("GA4 property id must be numeric");

    const rows: Ga4Row[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await requestJson(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
          dimensions: ["date", "sessionCampaignName", "sessionSource", "sessionMedium"].map((name) => ({ name })),
          metrics: ["sessions", "keyEvents", "totalRevenue"].map((name) => ({ name })),
          limit: PAGE, offset,
        }),
      }, { fetchFn: this.fetchFn, sleep: this.sleep });
      this.assertOk(res);
      const page: Ga4Response = res.json ?? {};
      rows.push(...(page.rows ?? []));
      if (rows.length >= (page.rowCount ?? 0) || !(page.rows?.length)) break;
    }
    return normalizeGa4(rows);
  }

  private assertOk(res: HttpResult) {
    if (res.ok) return;
    const raw = res.json?.error?.message ?? `HTTP ${res.status}`;
    // Google blocks API access to some properties, notably its public demo property.
    const hint = /denied access to the API/i.test(raw) ? " This property does not allow API access (Google's public demo property is one). Disconnect it and choose a property you own." : "";
    const msg = `GA4 API error: ${raw}${hint}`;
    if (res.status === 401 || res.status === 403) throw new ConnectorAuthError(`${msg} (does this Google account have access to the GA4 property?)`);
    throw new ConnectorError(msg, res.status);
  }
}

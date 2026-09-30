import { ConnectorAuthError, ConnectorError, requestJson, type HttpResult } from "./http";
import type { CampaignInfo, Connector, ConnectorResult, DateRange, MetricRow } from "./types";

export const META_API_VERSION = process.env.META_API_VERSION ?? "v25.0";
/** Meta reports the same event under several overlapping action types; count exactly one. */
export const DEFAULT_CONVERSION_ACTION = "purchase";

// Graph API error codes: 190 = invalid/expired token; 4, 17, 32, 613 = rate limits (sent with HTTP 400).
const AUTH_CODES = new Set([190, 102, 10, 200]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

export type MetaCredentials = { accessToken: string; adAccountId: string; conversionAction?: string };

type Action = { action_type: string; value: string };
export type MetaInsightRow = {
  campaign_id: string; campaign_name: string; date_start: string;
  impressions?: string; clicks?: string; spend?: string; actions?: Action[]; action_values?: Action[];
};

export const normalizeAdAccountId = (id: string) => {
  const v = id.trim();
  if (/^act_\d+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return `act_${v}`;
  throw new Error("Meta ad account id must look like act_1234567890");
};

const num = (v: string | undefined) => (v === undefined || v === "" ? 0 : Number(v));
const sumAction = (list: Action[] | undefined, type: string) =>
  (list ?? []).filter((a) => a.action_type === type).reduce((t, a) => t + Number(a.value), 0);

export function normalizeMeta(rows: MetaInsightRow[], conversionAction = DEFAULT_CONVERSION_ACTION): ConnectorResult {
  const campaigns = new Map<string, CampaignInfo>();
  const out: MetricRow[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  for (const r of rows) {
    const values = [num(r.impressions), num(r.clicks), num(r.spend), sumAction(r.actions, conversionAction), sumAction(r.action_values, conversionAction)];
    if (!r.campaign_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date_start ?? "") || values.some((v) => !Number.isFinite(v) || v < 0)) { skip("invalid_row"); continue; }
    const id = `meta_${r.campaign_id}`;
    campaigns.set(id, { id, name: r.campaign_name || r.campaign_id, channel: "meta_ads", source: "meta_ads" });
    const [impressions, clicks, spend, conversions, revenue] = values;
    out.push({ campaignId: id, date: r.date_start, impressions, clicks, spend, conversions, revenue });
  }
  return { campaigns: [...campaigns.values()], rows: out, skipped };
}

export class MetaConnector implements Connector {
  readonly provider = "meta_ads" as const;
  constructor(private readonly creds: MetaCredentials, private readonly fetchFn: typeof fetch = fetch, private readonly sleep?: (ms: number) => Promise<void>) {}

  async fetch(range: DateRange): Promise<ConnectorResult> {
    const account = normalizeAdAccountId(this.creds.adAccountId);
    const rows: MetaInsightRow[] = [];
    let after: string | undefined;

    do {
      const params = new URLSearchParams({
        level: "campaign", time_increment: "1", limit: "500",
        time_range: JSON.stringify({ since: range.startDate, until: range.endDate }),
        fields: "campaign_id,campaign_name,impressions,clicks,spend,actions,action_values",
      });
      if (after) params.set("after", after);
      // Token goes in a header, never the URL, so it cannot appear in logs or error messages.
      const res = await requestJson(`https://graph.facebook.com/${META_API_VERSION}/${account}/insights?${params}`, {
        headers: { authorization: `Bearer ${this.creds.accessToken}` },
      }, { fetchFn: this.fetchFn, sleep: this.sleep, retryIf: (r) => RATE_LIMIT_CODES.has(r.json?.error?.code) });
      this.assertOk(res);
      rows.push(...(res.json?.data ?? []));
      // Follow the cursor, not paging.next: that URL embeds the access token.
      after = res.json?.paging?.next ? res.json?.paging?.cursors?.after : undefined;
    } while (after);

    return normalizeMeta(rows, this.creds.conversionAction);
  }

  private assertOk(res: HttpResult) {
    if (res.ok) return;
    const e = res.json?.error;
    const msg = `Meta API error${e?.code ? ` ${e.code}` : ""}: ${e?.message ?? `HTTP ${res.status}`}`;
    if (AUTH_CODES.has(e?.code) || res.status === 401) throw new ConnectorAuthError(msg);
    throw new ConnectorError(msg, res.status);
  }
}

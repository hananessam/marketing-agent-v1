import { aggregate, calculateMetrics } from "@marketing/shared";

/** Deterministic analysis. The LLM never computes numbers; it only explains these facts. */

export const METRICS = [
  "impressions", "clicks", "spend", "conversions", "revenue", "ctr", "conversionRate", "cpc", "cpa", "roas",
] as const;
export type MetricName = (typeof METRICS)[number];
export type PeriodName = "current" | "previous";

export type DailyRow = {
  date: string; channel: string;
  impressions: number; clicks: number; spend: number; conversions: number; revenue: number;
};
export type CampaignInput = { campaignId: string; name: string; channel: string; daily: DailyRow[] };

export type Period = { startDate: string; endDate: string };
export type PeriodStats = Record<MetricName, number | null> & { daysWithData: number };

export type CampaignFacts = {
  campaignId: string; name: string; channel: string;
  current: PeriodStats; previous: PeriodStats;
  /** relative change (0.1 = +10%), null when not computable */
  changes: Record<MetricName, number | null>;
  dataQuality: { missingDatesCurrent: string[]; missingDatesPrevious: string[]; latestDate: string | null; lowConfidence: boolean };
};

export type DataQualityIssue = {
  campaignId: string;
  type: "no_data" | "stale_data" | "missing_days";
  detail: string;
};

export type Anomaly = {
  campaignId: string;
  type: "conversion_rate_drop" | "cpa_increase" | "roas_drop" | "efficient_spend_increase";
  severity: "high" | "medium" | "info";
  description: string;
  metrics: MetricName[];
  /** True when missing/stale data could explain the change — treat as unconfirmed. */
  lowConfidence: boolean;
};

export const THRESHOLDS = {
  minClicks: 100, // per period, for rate-based rules
  dropPct: 0.25,
  highPct: 0.5,
  cpaIncreasePct: 0.3,
  scaleSpendPct: 0.25,
  stableCpaPct: 0.1,
};

export const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

export function periodsFor(endDate: string, days: number): { current: Period; previous: Period } {
  return {
    current: { startDate: addDays(endDate, -(days - 1)), endDate },
    previous: { startDate: addDays(endDate, -(2 * days - 1)), endDate: addDays(endDate, -days) },
  };
}

const datesIn = (p: Period) => {
  const out: string[] = [];
  for (let d = p.startDate; d <= p.endDate; d = addDays(d, 1)) out.push(d);
  return out;
};

function stats(rows: DailyRow[]): PeriodStats {
  const t = aggregate(rows);
  const d = calculateMetrics(t);
  return { ...t, ...d, daysWithData: rows.length };
}

const pct = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : (cur - prev) / prev);

export function buildFacts(campaigns: CampaignInput[], endDate: string, days: number) {
  const { current, previous } = periodsFor(endDate, days);
  const issues: DataQualityIssue[] = [];

  const facts: CampaignFacts[] = campaigns.map((c) => {
    const inP = (p: Period) => c.daily.filter((r) => r.date >= p.startDate && r.date <= p.endDate);
    const cur = inP(current);
    const prev = inP(previous);
    const have = new Set(c.daily.map((r) => r.date));
    const missingCurrent = datesIn(current).filter((d) => !have.has(d));
    const missingPrevious = datesIn(previous).filter((d) => !have.has(d));
    const latestDate = c.daily.at(-1)?.date ?? null;

    if (!c.daily.length) issues.push({ campaignId: c.campaignId, type: "no_data", detail: "No metrics in either period" });
    else {
      if (latestDate! < endDate) issues.push({ campaignId: c.campaignId, type: "stale_data", detail: `Latest data is ${latestDate}, expected ${endDate}` });
      if (missingCurrent.length || missingPrevious.length)
        issues.push({ campaignId: c.campaignId, type: "missing_days", detail: `Missing days: ${[...missingPrevious, ...missingCurrent].join(", ")}` });
    }

    const cs = stats(cur);
    const ps = stats(prev);
    const changes = Object.fromEntries(METRICS.map((m) => [m, pct(cs[m], ps[m])])) as CampaignFacts["changes"];
    return {
      campaignId: c.campaignId, name: c.name, channel: c.channel, current: cs, previous: ps, changes,
      dataQuality: { missingDatesCurrent: missingCurrent, missingDatesPrevious: missingPrevious, latestDate, lowConfidence: !c.daily.length || latestDate! < endDate || missingCurrent.length > 0 || missingPrevious.length > 0 },
    };
  });

  return { periods: { current, previous }, facts, dataQualityIssues: issues };
}

const fmt = (v: number | null, digits = 1) => (v === null ? "n/a" : (v * 100).toFixed(digits) + "%");

export function detectAnomalies(facts: CampaignFacts[]): Anomaly[] {
  const T = THRESHOLDS;
  const out: Anomaly[] = [];
  for (const f of facts) {
    const lowConfidence = f.dataQuality.lowConfidence;
    const enough = (f.current.clicks ?? 0) >= T.minClicks && (f.previous.clicks ?? 0) >= T.minClicks;
    const c = f.changes;
    const sev = (x: number) => (Math.abs(x) >= T.highPct ? "high" : "medium") as "high" | "medium";

    if (enough && c.conversionRate !== null && c.conversionRate <= -T.dropPct)
      out.push({ campaignId: f.campaignId, type: "conversion_rate_drop", severity: sev(c.conversionRate), metrics: ["conversionRate", "clicks", "conversions"], lowConfidence,
        description: `Conversion rate ${fmt(f.previous.conversionRate, 2)} → ${fmt(f.current.conversionRate, 2)} (${fmt(c.conversionRate, 0)}) while CTR moved ${fmt(c.ctr, 0)}` });
    if (enough && c.cpa !== null && c.cpa >= T.cpaIncreasePct)
      out.push({ campaignId: f.campaignId, type: "cpa_increase", severity: sev(c.cpa), metrics: ["cpa", "spend", "conversions"], lowConfidence,
        description: `CPA ${f.previous.cpa?.toFixed(2)} → ${f.current.cpa?.toFixed(2)} (+${fmt(c.cpa, 0)})` });
    if (enough && c.roas !== null && c.roas <= -T.dropPct)
      out.push({ campaignId: f.campaignId, type: "roas_drop", severity: sev(c.roas), metrics: ["roas", "spend", "revenue"], lowConfidence,
        description: `ROAS ${f.previous.roas?.toFixed(2)} → ${f.current.roas?.toFixed(2)} (${fmt(c.roas, 0)})` });
    if (enough && c.spend !== null && c.spend >= T.scaleSpendPct && c.cpa !== null && Math.abs(c.cpa) <= T.stableCpaPct && c.roas !== null && c.roas >= -T.stableCpaPct)
      out.push({ campaignId: f.campaignId, type: "efficient_spend_increase", severity: "info", metrics: ["spend", "cpa", "roas"], lowConfidence,
        description: `Spend ${fmt(c.spend, 0)} higher with CPA ${fmt(c.cpa, 0)} and ROAS ${fmt(c.roas, 0)}: efficiency held` });
  }
  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function metricValue(f: CampaignFacts, period: PeriodName, metric: MetricName): number | null {
  return f[period][metric];
}

import type { CampaignMetric } from "@/lib/schemas/campaign";

type Counts = Pick<CampaignMetric, "impressions" | "clicks" | "spend" | "conversions" | "revenue">;

export function calculateMetrics(row: Counts) {
  return {
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    conversionRate: row.clicks ? row.conversions / row.clicks : 0,
    cpc: row.clicks ? row.spend / row.clicks : 0,
    cpa: row.conversions ? row.spend / row.conversions : null,
    roas: row.spend ? row.revenue / row.spend : null,
  };
}

/** Sum rows first, then derive ratios (never average ratios). */
export function aggregate(rows: Counts[]): Counts {
  return rows.reduce<Counts>(
    (a, r) => ({
      impressions: a.impressions + r.impressions,
      clicks: a.clicks + r.clicks,
      spend: a.spend + r.spend,
      conversions: a.conversions + r.conversions,
      revenue: a.revenue + r.revenue,
    }),
    { impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 },
  );
}

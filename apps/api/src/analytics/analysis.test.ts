import { describe, expect, it } from "vitest";
import { addDays, buildFacts, detectAnomalies, periodsFor, type CampaignInput, type DailyRow } from "./analysis";

const END = "2026-03-14";

function series(opts: { prev: Partial<DailyRow>; cur: Partial<DailyRow>; skip?: string[] }): DailyRow[] {
  const base = { channel: "meta_ads", impressions: 10000, clicks: 200, spend: 200, conversions: 10, revenue: 500 };
  const rows: DailyRow[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(END, -i);
    if (opts.skip?.includes(date)) continue;
    rows.push({ date, ...base, ...(i >= 7 ? opts.prev : opts.cur) });
  }
  return rows;
}
const camp = (daily: DailyRow[], id = "c1"): CampaignInput => ({ campaignId: id, name: id, channel: "meta_ads", daily });

describe("analysis", () => {
  it("computes non-overlapping periods", () => {
    const p = periodsFor(END, 7);
    expect(p.current).toEqual({ startDate: "2026-03-08", endDate: END });
    expect(p.previous).toEqual({ startDate: "2026-03-01", endDate: "2026-03-07" });
  });

  it("flags a conversion-rate collapse with related CPA/ROAS anomalies", () => {
    const { facts } = buildFacts([camp(series({ prev: {}, cur: { conversions: 3, revenue: 150 } }))], END, 7);
    const types = detectAnomalies(facts).map((a) => a.type);
    expect(types).toContain("conversion_rate_drop");
    expect(types).toContain("cpa_increase");
    expect(types).toContain("roas_drop");
    expect(facts[0].changes.conversionRate).toBeCloseTo(-0.7);
    expect(facts[0].dataQuality.lowConfidence).toBe(false);
  });

  it("reports nothing for stable performance", () => {
    const { facts } = buildFacts([camp(series({ prev: {}, cur: {} }))], END, 7);
    expect(detectAnomalies(facts)).toEqual([]);
  });

  it("marks anomalies low-confidence when days are missing or data is stale", () => {
    const missing = buildFacts([camp(series({ prev: {}, cur: { conversions: 3 }, skip: [END, addDays(END, -1)] }))], END, 7);
    expect(missing.dataQualityIssues.map((i) => i.type)).toEqual(expect.arrayContaining(["stale_data", "missing_days"]));
    expect(detectAnomalies(missing.facts).every((a) => a.lowConfidence)).toBe(true);
  });

  it("ignores small samples", () => {
    const { facts } = buildFacts([camp(series({ prev: { clicks: 5, conversions: 1 }, cur: { clicks: 5, conversions: 0 } }))], END, 7);
    expect(detectAnomalies(facts)).toEqual([]);
  });

  it("detects efficient scaling as info, not a problem", () => {
    const { facts } = buildFacts([camp(series({ prev: {}, cur: { clicks: 300, conversions: 15, spend: 300, revenue: 750 } }))], END, 7);
    const a = detectAnomalies(facts);
    expect(a.map((x) => x.type)).toEqual(["efficient_spend_increase"]);
    expect(a[0].severity).toBe("info");
  });

  it("reports no_data for empty campaigns", () => {
    const { dataQualityIssues } = buildFacts([camp([])], END, 7);
    expect(dataQualityIssues[0].type).toBe("no_data");
  });
});

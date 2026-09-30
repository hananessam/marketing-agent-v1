import { describe, expect, it } from "vitest";
import { aggregate, calculateMetrics } from "./metrics";

describe("calculateMetrics", () => {
  it("derives ratios", () => {
    const m = calculateMetrics({ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300 });
    expect(m.ctr).toBeCloseTo(0.05);
    expect(m.conversionRate).toBeCloseTo(0.1);
    expect(m.cpc).toBeCloseTo(2);
    expect(m.cpa).toBeCloseTo(20);
    expect(m.roas).toBeCloseTo(3);
  });
  it("handles zero denominators", () => {
    const m = calculateMetrics({ impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 });
    expect(m).toEqual({ ctr: 0, conversionRate: 0, cpc: 0, cpa: null, roas: null });
  });
  it("aggregates by summing", () => {
    const a = aggregate([
      { impressions: 1, clicks: 1, spend: 1, conversions: 1, revenue: 1 },
      { impressions: 2, clicks: 2, spend: 2, conversions: 2, revenue: 2 },
    ]);
    expect(a.impressions).toBe(3);
  });
});

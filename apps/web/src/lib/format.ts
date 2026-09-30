import type { Metric } from "./types";

const RATIO: Metric[] = ["ctr", "conversionRate"];
const MONEY: Metric[] = ["spend", "revenue", "cpc", "cpa"];

export function formatMetric(m: Metric, v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  if (RATIO.includes(m)) return `${(v * 100).toFixed(2)}%`;
  if (MONEY.includes(m)) return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  if (m === "roas") return `${v.toFixed(2)}x`;
  return Math.round(v).toLocaleString();
}

export const formatChange = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`);
export const label = (s: string) => s.replace(/_/g, " ");

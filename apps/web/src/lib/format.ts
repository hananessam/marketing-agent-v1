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

/** Plain-language names for the metrics, for people who do not live in ad dashboards. */
export const METRIC_LABEL: Record<Metric, { name: string; hint: string }> = {
  impressions: { name: "Views", hint: "How many times the ads were shown" },
  clicks: { name: "Clicks", hint: "How many people clicked" },
  spend: { name: "Spend", hint: "Money spent on ads" },
  conversions: { name: "Conversions", hint: "Purchases, sign-ups or leads, depending on the campaign" },
  revenue: { name: "Revenue", hint: "Money earned from conversions" },
  ctr: { name: "Click rate", hint: "Share of views that became clicks (CTR)" },
  conversionRate: { name: "Conversion rate", hint: "Share of clicks that became conversions" },
  cpc: { name: "Cost per click", hint: "Average price of one click (CPC)" },
  cpa: { name: "Cost per conversion", hint: "Average price of one conversion (CPA)" },
  roas: { name: "Return on ad spend", hint: "Revenue earned for every $1 spent (ROAS)" },
};

export const ACTION_LABEL: Record<string, string> = {
  pause_creative: "Pause an ad",
  new_variant: "Test a new version",
  fix_landing_page: "Fix the landing page",
  exclude_audience: "Exclude an audience",
  adjust_email_timing: "Change email timing",
  reallocate_budget: "Move budget",
  investigate_tracking: "Check data tracking",
};

export const ANOMALY_LABEL: Record<string, string> = {
  conversion_rate_drop: "Fewer visitors are converting",
  cpa_increase: "Each conversion costs more",
  roas_drop: "Less revenue per dollar spent",
  efficient_spend_increase: "Spending more, with the same efficiency",
};

export const DATA_ISSUE_LABEL: Record<string, string> = {
  stale_data: "Data is out of date",
  missing_days: "Some days are missing",
  no_data: "No data yet",
};

/** "3 hours ago", "yesterday"; `now` is passed in so rendering stays pure. */
export function timeAgo(iso: string, now: number): string {
  const secs = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(secs);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(secs / 3600), "hour");
  return rtf.format(Math.round(secs / 86_400), "day");
}

/** "Sep 24 – 30" style range from two ISO dates. */
export function dateRange(a: string, b: string): string {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...o });
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth ? `${f(a, { month: "short", day: "numeric" })} – ${f(b, { day: "numeric" })}` : `${f(a, { month: "short", day: "numeric" })} – ${f(b, { month: "short", day: "numeric" })}`;
}

/**
 * Tidies AI-written prose for display: internal campaign ids become campaign names and a few internal
 * terms become plain words. Applied to older saved analyses as well as new ones.
 */
export function humanize(text: string, names: Map<string, string>): string {
  let out = text;
  for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(name);
  return out
    .replace(/\blow[- ]?confidence\b/gi, "incomplete")
    .replace(/\bcampaign (?=[A-Z][\w ]+ campaign)/g, "") // "campaign Meta Lookalike campaign" -> "Meta Lookalike campaign"
    .replace(/\bCPA\b/g, "cost per conversion")
    .replace(/\bROAS\b/g, "return on ad spend")
    .replace(/\bCTR\b/g, "click rate");
}

const KIND_LABEL: Record<string, string> = {
  email_subject: "subject line", email_body: "body", ad_headline: "headline", ad_description: "description",
  social_post: "post", landing_copy: "landing page copy", cta: "button text",
};
const CHANNEL_NAME: Record<string, string> = { email: "Email", google_ads: "Google Ads", meta_ads: "Meta Ads", linkedin: "LinkedIn", blog: "Blog" };

/** "[google_ads/ad_headline/A] too_long: 34 chars, max 30; ..." -> "Google ads ad headline (version A) is too long: 34 characters, the limit is 30." */
export function friendlyViolation(raw: string): string {
  const m = /^\[(.+?)\] (\w+): ([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  const [, where, rule, detail] = m;
  const [channel, kind, variant] = where.split("/");
  const name = CHANNEL_NAME[channel] ?? label(channel);
  const what = kind ? `${name} ${KIND_LABEL[kind] ?? label(kind)}${variant ? ` (version ${variant})` : ""}` : name;
  return `${what} ${friendlyRule(rule, detail)}`;
}

/** The rule part alone, for messages shown on the asset itself. */
export function friendlyRule(rule: string, detail: string): string {
  if (rule === "too_long") {
    const n = /(\d+) chars, max (\d+)/.exec(detail);
    return n ? `is too long: ${n[1]} characters, the limit is ${n[2]}.` : "is too long.";
  }
  if (rule === "prohibited_phrase") return `uses a phrase your brand rules prohibit. ${detail}`;
  if (rule === "unsupported_claim") return `makes a claim that is not on your approved list: ${detail}`;
  if (rule === "missing_channel") return "has no content, but you asked for it.";
  if (rule === "needs_variants") return "needs at least two versions to test.";
  return `${detail}`;
}

/** An issue as stored on an asset ("too_long: 34 chars, max 30; ..."), reworded for the asset card. */
export function friendlyIssue(issue: string): string {
  const i = issue.indexOf(": ");
  const rule = i > 0 ? issue.slice(0, i) : "";
  const detail = i > 0 ? issue.slice(i + 2) : issue;
  const text = friendlyRule(rule, detail);
  const shorten = /shorten by at least (\d+)/.exec(detail);
  return `This copy ${text}${shorten ? ` Cut at least ${shorten[1]}.` : ""}`;
}

import type { AssetKind, ContentAsset } from "./content.schema";

export type BrandRules = { approvedClaims: string[]; prohibited: string[]; allowedDomains: string[] };
export type Violation = { where: string; rule: string; detail: string };

export const ALLOWED_KINDS: Record<string, AssetKind[]> = {
  google_ads: ["ad_headline", "ad_description", "cta"],
  meta_ads: ["ad_headline", "ad_description", "social_post", "cta"],
};

const DEFAULT_MAX: Partial<Record<AssetKind, number>> = { cta: 40, social_post: 600 };
/** Per-channel limits; Google Ads is the strictest. */
const CHANNEL_MAX: Record<string, Partial<Record<AssetKind, number>>> = {
  google_ads: { ad_headline: 30, ad_description: 90 },
  meta_ads: { ad_headline: 40, ad_description: 125 },
};
export const maxLength = (channel: string, kind: AssetKind) => CHANNEL_MAX[channel]?.[kind] ?? DEFAULT_MAX[kind];

/** Wording that implies an offer or superlative; only allowed if an approved claim contains it. */
const RISKY = [
  /\b\d+(?:\.\d+)?\s?%/gi, /\bfree\b/gi, /\bguarantee[ds]?\b/gi, /\brisk[- ]free\b/gi, /\bdiscount\b/gi,
  /\blimited[- ]time\b/gi, /\bonly \d+ left\b/gi, /#1/gi, /\bbest in\b/gi, /\bnumber one\b/gi, /\bcure[sd]?\b/gi,
];
const URL_RE = /\bhttps?:\/\/[^\s)>\]"']+/gi;
const REQUIRED_UTM = ["utm_source", "utm_medium", "utm_campaign"];

const norm = (s: string) => s.toLowerCase();

/** Text-level rules shared by plan text and asset copy. */
export function checkText(where: string, text: string, brand: BrandRules): Violation[] {
  const out: Violation[] = [];
  const lower = norm(text);

  for (const p of brand.prohibited)
    if (p.trim() && lower.includes(norm(p))) out.push({ where, rule: "prohibited_phrase", detail: `Contains prohibited phrase "${p}"` });

  const approved = brand.approvedClaims.map(norm).join(" | ");
  for (const re of RISKY)
    for (const m of text.matchAll(re)) {
      if (!approved.includes(norm(m[0]))) out.push({ where, rule: "unsupported_claim", detail: `"${m[0]}" is not backed by an approved claim` });
    }

  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    let u: URL;
    try { u = new URL(raw); } catch { out.push({ where, rule: "invalid_url", detail: `Malformed URL ${raw}` }); continue; }
    if (u.protocol !== "https:") out.push({ where, rule: "insecure_url", detail: `${raw} must use https` });
    const host = u.hostname.toLowerCase();
    if (!brand.allowedDomains.some((d) => host === norm(d) || host.endsWith("." + norm(d))))
      out.push({ where, rule: "unapproved_domain", detail: `${host} is not an allowed link domain` });
    const missing = REQUIRED_UTM.filter((k) => !u.searchParams.get(k));
    if (missing.length) out.push({ where, rule: "missing_tracking", detail: `${raw} is missing ${missing.join(", ")}` });
  }
  return out;
}

export function checkAsset(a: ContentAsset, brand: BrandRules, label = `${a.channel}/${a.kind}/${a.variant}`): Violation[] {
  const out = checkText(label, a.content, brand);
  if (!(ALLOWED_KINDS[a.channel] ?? []).includes(a.kind)) out.push({ where: label, rule: "invalid_kind", detail: `${a.kind} is not valid for ${a.channel}` });
  const max = maxLength(a.channel, a.kind);
  if (max && a.content.length > max) {
    // Quote the text and say by how much, so a retry can fix the exact line instead of guessing.
    out.push({ where: label, rule: "too_long", detail: `${a.content.length} chars, max ${max}; shorten by at least ${a.content.length - max}: "${a.content.slice(0, 160)}"` });
  }
  if (!a.content.trim()) out.push({ where: label, rule: "empty", detail: "Empty content" });
  for (const c of a.claimsUsed)
    if (!brand.approvedClaims.some((x) => norm(x) === norm(c))) out.push({ where: label, rule: "unapproved_claim_cited", detail: `Cited claim "${c}" is not an approved claim` });
  return out;
}

/** Whole-draft rules: channel coverage, plus every asset. */
export function checkDraft(assets: ContentAsset[], briefChannels: string[], brand: BrandRules): Violation[] {
  const out = assets.flatMap((a) => checkAsset(a, brand));
  for (const a of assets)
    if (!briefChannels.includes(a.channel)) out.push({ where: `${a.channel}/${a.kind}/${a.variant}`, rule: "channel_not_in_brief", detail: `${a.channel} was not requested` });
  for (const ch of briefChannels)
    if (!assets.some((a) => a.channel === ch)) out.push({ where: ch, rule: "missing_channel", detail: `No content for ${ch}` });
  return out;
}

/**
 * Fit problems a person can fix by editing. Everything else (banned phrases, unsupported claims, bad links,
 * missing channels) is a hard stop: the draft is rejected rather than saved.
 */
export const isSoftViolation = (v: Violation) => v.rule === "too_long";

export const formatViolations = (v: Violation[]) => v.map((x) => `[${x.where}] ${x.rule}: ${x.detail}`);

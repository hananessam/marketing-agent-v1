import { describe, expect, it } from "vitest";
import { checkAsset, checkDraft, checkText, isSoftViolation, type BrandRules } from "./content-policy";
import type { ContentAsset } from "./content.schema";

const brand: BrandRules = {
  approvedClaims: ["Free 30-day trial", "Set up in under 10 minutes"],
  prohibited: ["guaranteed results", "testimonial"],
  allowedDomains: ["acme.example"],
};
const asset = (over: Partial<ContentAsset> = {}): ContentAsset => ({
  channel: "email", kind: "email_subject", variant: "A", content: "Plan your week", claimsUsed: [], ...over,
});
const rules = (v: { rule: string }[]) => v.map((x) => x.rule);

describe("content policy", () => {
  it("passes clean copy", () => expect(checkAsset(asset(), brand)).toEqual([]));

  it("blocks prohibited phrases case-insensitively", () => {
    expect(rules(checkText("x", "Get GUARANTEED RESULTS today", brand))).toContain("prohibited_phrase");
  });

  it("blocks unsupported offers and numbers but allows approved claims", () => {
    expect(rules(checkText("x", "50% off for everyone", brand))).toContain("unsupported_claim");
    expect(rules(checkText("x", "Try our best in class planner", brand))).toContain("unsupported_claim");
    expect(checkText("x", "Start your free 30-day trial", brand)).toEqual([]);
    expect(rules(checkText("x", "Free forever plan", brand))).toEqual([]); // "free" appears in an approved claim
  });

  it("validates links: https, allowed domain, UTM params", () => {
    const good = "https://acme.example/go?utm_source=e&utm_medium=email&utm_campaign=spring";
    expect(checkText("x", `Go ${good}`, brand)).toEqual([]);
    expect(checkText("x", `Go https://app.acme.example/go?utm_source=e&utm_medium=email&utm_campaign=s.`, brand)).toEqual([]);
    expect(rules(checkText("x", "Go http://acme.example/?utm_source=e&utm_medium=m&utm_campaign=c", brand))).toContain("insecure_url");
    expect(rules(checkText("x", "Go https://evil.example/?utm_source=e&utm_medium=m&utm_campaign=c", brand))).toContain("unapproved_domain");
    expect(rules(checkText("x", "Go https://acme.example/pricing", brand))).toContain("missing_tracking");
    expect(rules(checkText("x", "Go https://notacme.example/?utm_source=e&utm_medium=m&utm_campaign=c", brand))).toContain("unapproved_domain");
  });

  it("enforces length limits, valid kinds and cited claims", () => {
    expect(rules(checkAsset(asset({ channel: "google_ads", kind: "ad_headline", content: "x".repeat(31) }), brand))).toContain("too_long");
    expect(checkAsset(asset({ channel: "linkedin", kind: "ad_headline", content: "x".repeat(70) }), brand)).toEqual([]);
    expect(rules(checkAsset(asset({ channel: "google_ads", kind: "email_body" }), brand))).toContain("invalid_kind");
    expect(rules(checkAsset(asset({ claimsUsed: ["Made-up claim"] }), brand))).toContain("unapproved_claim_cited");
    expect(checkAsset(asset({ claimsUsed: ["free 30-day trial"] }), brand)).toEqual([]);
  });

  it("explains a length problem precisely, and treats only length as fixable by hand", () => {
    const v = checkAsset(asset({ channel: "google_ads", kind: "ad_headline", content: "Plan faster with Acme Planner!" + "x".repeat(4) }), brand);
    expect(v[0].detail).toMatch(/^34 chars, max 30; shorten by at least 4: "Plan faster/);
    expect(v.every(isSoftViolation)).toBe(true);
    expect(isSoftViolation({ where: "x", rule: "prohibited_phrase", detail: "" })).toBe(false);
    expect(isSoftViolation({ where: "x", rule: "unsupported_claim", detail: "" })).toBe(false);
    expect(isSoftViolation({ where: "x", rule: "missing_tracking", detail: "" })).toBe(false);
  });

  it("requires every requested channel and at least two variants", () => {
    const one = checkDraft([asset()], ["email", "linkedin"], brand);
    expect(rules(one)).toEqual(expect.arrayContaining(["needs_variants", "missing_channel"]));
    const ok = checkDraft([asset(), asset({ variant: "B", content: "Your week, planned" })], ["email"], brand);
    expect(ok).toEqual([]);
    expect(rules(checkDraft([asset(), asset({ variant: "B" })], ["linkedin"], brand))).toContain("channel_not_in_brief");
  });
});

import { describe, expect, it } from "vitest";
import type { ContentAsset } from "./content.schema";
import { oneVersion } from "./writer";

const a = (channel: ContentAsset["channel"], kind: ContentAsset["kind"], variant: string, content: string): ContentAsset => ({ channel, kind, variant, content, claimsUsed: [] });

describe("one version of everything", () => {
  it("keeps the first copy of each kind per channel and labels it A, however many the model wrote", () => {
    const out = oneVersion([
      a("google_ads", "ad_headline", "A", "First headline"), a("google_ads", "ad_headline", "B", "Second headline"), a("google_ads", "ad_headline", "C", "Third"),
      a("google_ads", "ad_description", "B", "Only description"),
      a("meta_ads", "ad_headline", "A", "Meta headline"), a("meta_ads", "ad_headline", "B", "Meta alt"),
      a("meta_ads", "cta", "A", "Learn more"), a("meta_ads", "cta", "B", "Sign up"),
    ]);
    expect(out.map((x) => `${x.channel}/${x.kind}/${x.variant}: ${x.content}`)).toEqual([
      "google_ads/ad_headline/A: First headline",
      "google_ads/ad_description/A: Only description",
      "meta_ads/ad_headline/A: Meta headline",
      "meta_ads/cta/A: Learn more",
    ]);
  });

  it("leaves a draft that already has one version unchanged", () => {
    const one = [a("google_ads", "ad_headline", "A", "Plan your week"), a("google_ads", "ad_description", "A", "Simple planning")];
    expect(oneVersion(one)).toEqual(one);
    expect(oneVersion([])).toEqual([]);
  });
});

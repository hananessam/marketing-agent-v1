import { z } from "zod";

export const ASSET_KINDS = [
  "ad_headline", "ad_description", "social_post", "cta",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ContentAsset = z.object({
  channel: z.enum(["google_ads", "meta_ads"]),
  kind: z.enum(ASSET_KINDS),
  variant: z.string().describe('Variant label such as "A" or "B"'),
  content: z.string(),
  claimsUsed: z.array(z.string()).describe("Approved claims, copied verbatim, that this copy relies on; empty if none"),
});
export type ContentAsset = z.infer<typeof ContentAsset>;

export const ContentDraft = z.object({ assets: z.array(ContentAsset) });
export type ContentDraft = z.infer<typeof ContentDraft>;

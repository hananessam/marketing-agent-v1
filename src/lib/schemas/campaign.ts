import { z } from "zod";

export const Channel = z.enum(["email", "google_ads", "meta_ads", "linkedin", "blog"]);
export const PaidOrEmailChannel = z.enum(["email", "google_ads", "meta_ads", "linkedin"]);

export const CampaignBrief = z.object({
  objective: z.enum(["awareness", "leads", "sales", "retention"]),
  product: z.string().min(1),
  audience: z.string().min(1),
  channels: z.array(Channel).min(1),
  budget: z.number().nonnegative().optional(),
  durationDays: z.number().int().positive(),
  constraints: z.array(z.string()).default([]),
});
export type CampaignBrief = z.infer<typeof CampaignBrief>;

export const CampaignPlan = z.object({
  objective: z.string(),
  audienceSegments: z.array(z.string()),
  positioning: z.string(),
  keyMessage: z.string(),
  channels: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      contentTypes: z.array(z.string()),
      successMetrics: z.array(z.string()),
    }),
  ),
  experiments: z.array(
    z.object({
      hypothesis: z.string(),
      variable: z.string(),
      variants: z.array(z.string()),
    }),
  ),
  risks: z.array(z.string()),
});
export type CampaignPlan = z.infer<typeof CampaignPlan>;

export const CampaignMetric = z.object({
  campaignId: z.string(),
  channel: PaidOrEmailChannel,
  date: z.string().date(),
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  spend: z.number().nonnegative(),
  conversions: z.number().nonnegative(),
  revenue: z.number().nonnegative(),
});
export type CampaignMetric = z.infer<typeof CampaignMetric>;

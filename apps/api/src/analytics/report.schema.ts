import { z } from "zod";
import { METRICS } from "./analysis";

export const ACTION_TYPES = [
  "pause_creative", "new_variant", "fix_landing_page", "exclude_audience",
  "adjust_email_timing", "reallocate_budget", "investigate_tracking",
] as const;

export const Evidence = z.object({
  campaignId: z.string(),
  metric: z.enum(METRICS),
  period: z.enum(["current", "previous"]),
  value: z.number(),
});

export const Recommendation = z.object({
  title: z.string(),
  actionType: z.enum(ACTION_TYPES),
  campaignId: z.string(),
  action: z.string().describe("The exact controllable action to take"),
  rationale: z.string(),
  evidence: z.array(Evidence).describe("Metric values copied exactly from the provided facts"),
  measurableOutcome: z.string().describe("How we will know it worked"),
});

/** What the model must return. Array sizes are enforced in the validate node, not the schema. */
export const ModelReport = z.object({
  summary: z.string(),
  biggestChanges: z.array(z.string()),
  recommendations: z.array(Recommendation),
  caveats: z.array(z.string()),
});
export type ModelReport = z.infer<typeof ModelReport>;

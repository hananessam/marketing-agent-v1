import type { ActionType as PolicyAction } from "@marketing/shared";
import { z } from "zod";

export const ACTION_KINDS = ["create_task", "pause_campaign", "change_budget", "publish_campaign"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Which approval rule from the shared policy governs each action. Drafts are automatic; everything else needs a human. */
export const POLICY_FOR: Record<ActionKind, PolicyAction> = {
  create_task: "draft",
  pause_campaign: "pause",
  change_budget: "change_budget",
  publish_campaign: "publish",
};

/** External actions change something outside this app, so they are only recorded (shadow mode) until a live executor exists. */
export const IS_EXTERNAL: Record<ActionKind, boolean> = {
  create_task: false, pause_campaign: true, change_budget: true, publish_campaign: true,
};

const campaignId = z.string().trim().min(1).max(100);
const reason = z.string().trim().max(500).default("");

export const PAYLOADS = {
  create_task: z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default(""), campaignId: campaignId.optional() }),
  pause_campaign: z.object({ campaignId, reason }),
  change_budget: z.object({ campaignId, direction: z.enum(["increase", "decrease"]), percent: z.number().positive().max(100), reason }),
  publish_campaign: z.object({ campaignId }),
} satisfies Record<ActionKind, z.ZodType>;

export const ProposeBody = z.object({
  type: z.enum(ACTION_KINDS),
  payload: z.unknown(),
  source: z.enum(["recommendation", "campaign", "manual"]).default("manual"),
  sourceRef: z.string().trim().max(200).optional(),
  requestedBy: z.string().trim().min(1).max(100).default("dashboard"),
});
export type ProposeBody = z.infer<typeof ProposeBody>;

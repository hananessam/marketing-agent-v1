import type { schema } from "../db";

export type ActionRow = typeof schema.actions.$inferSelect;
export type Outcome = { status: "executed" | "shadowed"; result: Record<string, unknown> };
export type MetaSettings = { dailyBudget: number; country: string; pageId: string; landingUrl: string };

/** What the actions service needs from whatever really posts to ad platforms. */
export interface Publisher {
  /** Synchronous checks (budget cap, landing page, permissions). Throws a readable HTTP error if the request cannot be posted. */
  preflight(workspaceId: string, campaignId: string, meta?: MetaSettings): void;
  publish(action: ActionRow): Promise<Outcome>;
}
export const PUBLISHER = Symbol("PUBLISHER");

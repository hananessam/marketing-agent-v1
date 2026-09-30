import { z } from "zod";

export const ActionType = z.enum(["draft", "report", "schedule", "publish", "change_budget", "pause", "delete"]);
export type ActionType = z.infer<typeof ActionType>;

export type Decision = "auto" | "needs_approval" | "never";

const POLICY: Record<ActionType, Decision> = {
  draft: "auto",
  report: "auto",
  schedule: "needs_approval", // sending email
  publish: "needs_approval",
  change_budget: "needs_approval",
  pause: "needs_approval",
  delete: "never",
};

export const MAX_BUDGET_CHANGE_PERCENT = 10;

export function decide(action: ActionType): Decision {
  return POLICY[action];
}

/** Unknown/invalid actions fail closed. */
export function decideUnknown(action: string): Decision {
  const parsed = ActionType.safeParse(action);
  return parsed.success ? decide(parsed.data) : "never";
}

export function budgetChangeAllowed(currentBudget: number, newBudget: number): boolean {
  if (currentBudget <= 0) return false;
  return (Math.abs(newBudget - currentBudget) / currentBudget) * 100 <= MAX_BUDGET_CHANGE_PERCENT;
}

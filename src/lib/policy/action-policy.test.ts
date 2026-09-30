import { describe, expect, it } from "vitest";
import { budgetChangeAllowed, decide, decideUnknown } from "./action-policy";

describe("action policy", () => {
  it("auto for drafts, approval for risky, never for delete", () => {
    expect(decide("draft")).toBe("auto");
    expect(decide("publish")).toBe("needs_approval");
    expect(decide("change_budget")).toBe("needs_approval");
    expect(decide("pause")).toBe("needs_approval");
    expect(decide("delete")).toBe("never");
  });
  it("fails closed on unknown actions", () => {
    expect(decideUnknown("drop_tables")).toBe("never");
  });
  it("caps budget change at 10%", () => {
    expect(budgetChangeAllowed(100, 110)).toBe(true);
    expect(budgetChangeAllowed(100, 111)).toBe(false);
  });
});

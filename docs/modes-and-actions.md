# Modes and actions

The agent can propose things to *do*, not just things to read. Everything goes through one gate: the approvals system. Every action is recorded (`GET /actions`). *The dashboard was simplified to three screens, so today it only exposes "Add to my to-do list"; pausing, budget changes and launch packages work through the API and can be given screens again.*

| Action | Where it comes from | Approval | What happens today |
|---|---|---|---|
| Add a task | "Add to my to-do list" on any recommendation | none (internal, harmless) | Runs immediately; appears in your to-do list on Home |
| Pause a campaign | "Propose pausing" on a recommendation | required | Demo mode (default): **paused in the sandbox**. Shadow mode: recorded, not applied |
| Change a budget (max 10% at a time) | "Propose a budget change" | required | Demo mode (default): **changed in the sandbox**. Shadow mode: recorded, not applied |
| Publish a campaign | **Approve campaign** (Meta copy) | required (the Approve button is the approval) | **Demo mode (the default): paused ads are created in the built-in ads sandbox.** With `EXECUTION_MODE=live` and posting allowed: paused ads are created on Meta. With `EXECUTION_MODE=shadow`: recorded, not applied |

**Shadow mode** (`EXECUTION_MODE=shadow`) is the first stage of the staged rollout in the original plan (read-only, then shadow, then approval, then limited autonomy). Your Meta and Google connections are read-only, so approving an external action records *exactly what would have happened* and changes nothing outside this app. The inbox says so before you decide, and Activity labels these "Recorded, not applied". `EXECUTION_MODE=live` does nothing extra yet: a real action type needs a live executor (one function in `apps/api/src/actions/actions.service.ts`) plus write permission on the platform, such as Meta `ads_management`. Until then it falls back to shadow and says why.

How it stays safe:
- Details are validated (typed, bounded) and a **preview of what would happen** is written when the action is proposed, so you approve something concrete.
- The action is **re-checked against current data when it runs**. If the campaign changed after you approved (for example it was paused meanwhile), the action fails instead of running.
- Each action is **claimed before it runs**, so approving twice, or two people approving at once, can never execute it twice. Identical proposals are not duplicated.
- Budget changes above 10%, pausing or re-budgeting a Google Analytics report, publishing an unapproved campaign, or scheduling in the past are refused.
- A rejected or failed action can be proposed again.

---

# Demo mode and the ads sandbox (the default)

`EXECUTION_MODE` picks where an approved campaign is posted:

| `EXECUTION_MODE` | Where approving posts | Needs |
|---|---|---|
| unset or `demo` (**default**) | The built-in **ads sandbox**: a pretend ad platform. No network calls, no login, nothing real is created and nothing can spend. | nothing |
| `live` | Your real Meta ad account (see below). | Meta connection with posting allowed |
| `shadow` | Nowhere: the approval is only recorded. | nothing |

In demo mode the sandbox behaves like a real platform: the same checks apply (daily budget between 1 and 50 USD, landing page must be https on one of your own websites, a Page must be chosen), ads are created **paused**, and a campaign cannot be posted twice. It creates one campaign and ad set plus one ad per variant on Meta, and one ad per variant for Google Ads (which the live mode cannot post yet). Approved **pause** requests mark the campaign paused in this app, and **budget changes** move a sandbox daily budget (starting from the budget the campaign was posted with, else its average daily spend, then building on the last change, always between 1 and 50 USD). The campaign page lists the pretend ad ids it created, and a **Demo mode** badge shows in the top bar. The live Meta code is unchanged and is used only when `EXECUTION_MODE=live`.

# Posting to Meta (live mode)

With `EXECUTION_MODE=live`, approving a campaign that has Facebook & Instagram copy creates the ads in your Meta ad account. It only ever creates things **paused**.

**What gets created:** one campaign (objective *Traffic*), one ad set (the daily budget and country you enter) and one ad for the campaign's copy (older campaigns may have versions A and B, one ad each), each using its own headline, description, post text and button. Links carry `utm_source/medium/campaign/content` tags so Google Analytics can attribute the visits. Nothing spends until *you* switch the ads on in Ads Manager. After creating them the app asks Meta to confirm each one really is paused (and pauses it if not).

**Turning it on (one time):**
1. In your Meta app, make sure the permissions `ads_management`, `pages_show_list` and `pages_read_engagement` are available. In **Development** mode they work for people who have a role on the app (Administrator, Developer or Tester), for their own ad accounts and Pages.
2. **Settings → Meta Ads → Allow posting** and accept the extra permissions (they are asked for separately from the read-only connection).
3. Add `EXECUTION_MODE=live` to `apps/api/.env.local` (optionally `MAX_DAILY_BUDGET=...`) and restart the API.
4. Your ad account needs billing set up and must be active, and you need a Facebook Page to post as.

**Using it:** open a draft, fill in the short form that appears (daily budget, country, Facebook Page, landing page; they are remembered for next time) and press **Approve and create paused ads on Meta**.

**Safeguards**
- Everything is created `PAUSED` and verified paused; if anything fails part-way, what was created is deleted again (each object explicitly, children first), and anything that could not be deleted is listed by id.
- Write requests are never retried after a timeout or server error (the ad might already exist), so a retry cannot create duplicates. Only Meta's explicit "rate limited, nothing was done" answers are retried.
- A campaign that has already been posted cannot be posted again, and identical requests are treated as one.
- The daily budget is capped (`MAX_DAILY_BUDGET`), the landing page must be https on one of your own websites, and the Facebook Page must be one the connected login manages. All of this is checked when you ask and again when it runs.
- The access token travels in a header, never in a URL, and is never written to logs or results.
- Without the extra permissions, live mode refuses to post and says why. With `EXECUTION_MODE` unset you are in demo mode, which never touches Meta.

**Limits (today):** Google Ads is not supported (it needs a Google Ads developer token, an extra sign-in permission and keyword generation), so that copy stays on the campaign page with Copy buttons. Ads are link ads with text only (no image or video, so Meta shows the landing page's preview image), optimised for clicks (a *Traffic* campaign), targeted by country only. Conversion tracking and richer targeting are not set up. Meta's API changes over time; if Meta rejects a request, the exact reason is shown on the campaign page.

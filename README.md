# Marketing Agent

An AI-assisted marketing workflow: it analyzes campaign performance, recommends next actions, and drafts campaigns. **It only drafts and recommends. Nothing is published, sent, or spent without human approval.**

- **Analytics:** compares the last period with the one before, checks data quality, detects anomalies, and proposes up to three actions backed by cited metrics.
- **Campaign drafting:** plan + content variants, checked against brand policy (prohibited phrases, unsupported claims, link domains/UTMs, length limits).
- **Approvals:** every risky action waits in an inbox; every tool call is audited.
- **Background jobs:** scheduled reports (BullMQ + Redis), optional Slack summaries.
- **Connectors:** sign in with Google (GA4) and Meta (Ads) from the dashboard; read-only, tokens stored encrypted.

## Layout

```
apps/web          Next.js dashboard (App Router, TanStack Query)
apps/api          NestJS API, LangGraph workflows (OpenAI), Drizzle + SQLite
packages/shared   Zod schemas, metrics math, approval policy
```

## Quick start (local, without Docker)

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm build:shared
cp -n .env.example apps/api/.env.local   # -n: never overwrite an existing file; then set OPENAI_API_KEY
pnpm db:push && pnpm seed               # create the SQLite db and load demo data
pnpm dev:api                            # http://localhost:4000
pnpm dev:web                            # http://localhost:3000
```

Other scripts: `pnpm test`, `pnpm typecheck`. After changing `packages/shared`, run `pnpm build:shared`.

Optional: Redis enables schedules and background jobs. Set `REDIS_URL=redis://localhost:6379` for the API. Without it the API still runs, and the Schedules page explains that jobs are disabled.

### What you see

The app has a top bar with **Home**, **Campaigns**, **Tool history** and **Settings**.

- **First time:** the home page is *only* a company form (name, products, audiences, brand voice, claims you may make, phrases to avoid, your website). Save it and Home becomes the overview. The assistant works from this: drafts are written in your voice about your products, and every draft is checked against your approved claims, banned phrases and allowed link domains. Saving writes exactly what the form shows, and new drafts use it immediately.
- **Home:** four headline numbers (compared with the previous week), "what to do next" (up to three recommendations, each with an *Add to my to-do list* button), your to-do list, and one-line notices (a campaign waiting for approval, an account to reconnect, sample data).
- **Campaigns:** a plain list. *New campaign* asks four things (goal, product, audience, where) and writes a draft, **showing live what it is doing**: each tool it uses by name (`get_brand_guidelines`, ...) and each step (writing the plan, checking it against your brand rules, writing the copy, shortening long lines), with a timer. The channels are **Google Ads** and **Facebook & Instagram (Meta) ads**. Copy that comes out longer than a platform allows (for example a Google Ads headline over 30 characters) is rewritten automatically: the AI proposes several shorter versions and the app measures them itself, so the model's counting is never trusted. Review the copy, edit or remove anything, then press **Approve campaign**. Not happy with the wording? **Rewrite all the copy with AI** writes every line again (optionally with a note such as "more playful"), keeping the plan, with different wording and the same brand and length checks. It replaces all the copy including your edits, and if the new copy can't follow your brand rules the current copy is kept. Approved copy is shown with Copy buttons: the app does not post anything for you yet.
- **Tool history:** every lookup the assistant made, shown by its tool name (`get_campaign_metrics`, `get_brand_guidelines`, ...), newest first, with the request and the raw result. Filter by tool, expand any entry. These calls only read; changes to ad accounts are never made here.
- **Settings:** your accounts (Google Analytics, Meta Ads; sign in to connect) and your company details. Old links such as `/connections`, `/approvals` and `/audit` redirect to where that screen now lives.

The backend is richer than the screens: approvals, agent actions, schedules and the action history all still exist behind the API, and screens for them can be added back.

### Run everything with Docker

Requires Docker Desktop (or Docker Engine with Compose v2).

```bash
cp -n .env.example apps/api/.env.local     # then set OPENAI_API_KEY (and the other keys you need)
docker compose up --build
```

- Web: http://localhost:3000, API: http://localhost:4000. Redis runs as a third container, so schedules and background jobs work without any setup.
- On first start the API applies the database migrations and loads the demo data once (`SEED_DEMO=false docker compose up` starts blank). Data persists in the `api-data` and `redis-data` volumes.
- Secrets are read from `apps/api/.env.local` when the container starts and are never baked into an image. `REDIS_URL`, `DATABASE_URL`, `API_PUBLIC_URL` and `WEB_ORIGIN` are set by `docker-compose.yml` and override the file, so a `localhost` Redis URL there is harmless.
- Ports are published on `127.0.0.1` only, because the app has no user login yet. Do not change them to `0.0.0.0` on a shared network.
- `NEXT_PUBLIC_API_URL` is compiled into the browser bundle. If you change it (for example when deploying), rebuild: `docker compose build web`.
- OAuth redirect URIs are unchanged (`http://localhost:4000/connections/oauth/...`), since the API is on the same published port.

Useful commands:

```bash
docker compose logs -f api        # follow API logs
docker compose down               # stop (data kept)
docker compose down -v            # stop and DELETE all data (database, Redis)
```

After you change `apps/api/src/db/schema.ts`, generate a migration so the Docker database gets it: `pnpm --filter api db:generate`, then commit the new file in `apps/api/drizzle/`. (`pnpm db:push` is only for the local dev database.)

## Environment variables

Put these in `apps/api/.env.local` (git-ignored). **Never commit them or paste them into chats or issues.** Web-only settings go in `apps/web/.env.local`.

| Variable | Needed for |
|---|---|
| `OPENAI_API_KEY` | Analysis and drafting (required) |
| `OPENAI_MODEL` | Optional, default `gpt-4.1-mini` |
| `DATABASE_URL` | Optional, default `local.db` |
| `REDIS_URL` | Schedules and background jobs |
| `SLACK_WEBHOOK_URL` | Optional Slack report summaries (`https://hooks.slack.com/...` only) |
| `CONNECTOR_ENCRYPTION_KEY` | Encrypting stored OAuth tokens |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Connect Google Analytics" |
| `META_APP_ID`, `META_APP_SECRET` | "Connect Meta Ads" |
| `API_PUBLIC_URL` | Optional, default `http://localhost:4000`; used to build OAuth redirect URIs |
| `WEB_ORIGIN` | Optional, default `http://localhost:3000`; where users return after signing in |
| `EXECUTION_MODE` | Optional, default `shadow`. Set to `live` to let **Approve campaign** create ads on Meta (see [Posting to Meta](#posting-to-meta)). Anything else only records what would be posted |
| `MAX_DAILY_BUDGET` | Optional, default `50`. Hard ceiling on the daily budget this app will ever set on an ad, whatever is typed into a form |
| `SYNC_CRON`, `SYNC_TIMEZONE` | Optional daily connector sync time, default `0 5 * * *` in `UTC`. At most hourly; invalid values fall back to the default |

---

## Connecting your accounts (OAuth)

Users link accounts from the dashboard's **Connections** page with a normal "Sign in" flow. There are no key files or pasted tokens. We ask for **read-only** access (`analytics.readonly` for Google, `ads_read` for Meta), tokens are stored AES-256-GCM encrypted per workspace, and they are never returned by the API.

OAuth needs credentials that identify **your app** to Google and Meta. You create them once; end users never see them.

### 1. Encryption key

```bash
openssl rand -base64 32
```

Save it as `CONNECTOR_ENCRYPTION_KEY=...` in `apps/api/.env.local`. Back it up: without it, stored connections cannot be decrypted.

### 2. Google: client id and secret

Do these in order. Skipping any of steps 2–4 produces one of the errors listed under [Troubleshooting](#troubleshooting).

1. **Project.** In [Google Cloud Console](https://console.cloud.google.com), create or select a project. Use the same project for every step below.
2. **Enable both APIs.** **APIs & Services → Library**, search for each, open it and click **Enable**:
   - **Google Analytics Data API** (reads the metrics)
   - **Google Analytics Admin API** (lists the GA4 properties you can choose from)
3. **Configure the consent screen.** **APIs & Services → OAuth consent screen** (newer consoles call it **Google Auth Platform**):
   - Choose user type **External** (or **Internal** if you are on a Google Workspace org and only your org will use it).
   - Fill in the app name and your support/developer email, then save.
   - **Data Access / Scopes → Add or remove scopes** → add `https://www.googleapis.com/auth/analytics.readonly`.
4. **Add yourself as a test user.** On the same screen (**Audience → Test users**), click **+ Add users** and enter every Google account that will sign in. It must be the account that has access to your GA4 property. Without this, sign-in fails with `Error 403: access_denied`. Up to 100 test users are allowed.
5. **Create the OAuth client.** **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs → Add URI**, and enter exactly `http://localhost:4000/connections/oauth/google/callback` (`http`, port `4000`, no trailing slash, `localhost` not `127.0.0.1`).
   - Create it, then copy the **Client ID** and **Client secret** into `apps/api/.env.local`.
6. **Restart the API** so it picks up the new environment variables. Google can take a few minutes to apply console changes.

```
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> **Testing mode limits:** while the consent screen's publishing status is **Testing**, Google expires refresh tokens after about 7 days and the connection shows "needs reconnect" (click **Reconnect**). To avoid that, click **Publish app** on the consent screen. For personal use (under about 100 users) Google then shows an "unverified app" warning that you can click through with **Advanced → Go to … (unsafe)**; full verification is only needed for public apps.

### 3. Meta: app id and secret

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → **Business** type.
2. **Add products:** add the **Marketing API** and **Facebook Login for Business** (or **Facebook Login**).
3. **Get the credentials:** **App settings → Basic** → copy the **App ID**; click Show next to **App Secret** (it may ask for your password).
4. **Redirect URI:** **Facebook Login → Settings** → add `http://localhost:4000/connections/oauth/meta/callback` to **Valid OAuth Redirect URIs** and save.
5. **Who can sign in:** keep the app in **Development** mode. Only people with a role on the app can authorize it, so add every person under **App roles → Roles** (Administrator, Developer or Tester) and have them accept the invitation. Each person also needs access to the ad account itself in Business settings. Letting anyone else connect requires Meta's App Review for `ads_read` advanced access.
6. Put the values in `apps/api/.env.local` and **restart the API**.

```
META_APP_ID=1234567890
META_APP_SECRET=...
```

> Meta has no refresh tokens: a login lasts about 60 days. The Connections page shows the expiry and a **Reconnect** button.

### 4. Connect

Restart the API, open **Connections**, click **Connect** on a provider and sign in. When you are redirected back, **pick the GA4 property or ad account** (this list needs the Admin API enabled for Google), then click **Connect and sync**. The first 30 days are pulled. Use **Sync now** to refresh, and **Remove demo data** once real data is in.

**Automatic sync:** with Redis running, every connected account is re-synced daily (last 7 days, because platforms restate recent numbers) at `SYNC_CRON`, ahead of typical morning report schedules. The Connections page shows the schedule and warns when data is more than 36 hours old. A sync that fails is retried with backoff; one that needs you to sign in again is not retried, and shows "needs reconnect". Without Redis, syncing is manual.

When you deploy, set `API_PUBLIC_URL` to your HTTPS URL and update the redirect URIs in both consoles to match exactly.

### Troubleshooting

| What you see | Cause and fix |
|---|---|
| Google: `Error 400: redirect_uri_mismatch` | The redirect URI in the console differs from the one the API sends. Add exactly `http://localhost:4000/connections/oauth/google/callback` (mind `/oauth/`, `http`, port, no trailing slash) and wait a few minutes. If you set `API_PUBLIC_URL`, the URI must use that origin instead. |
| Google: `Error 403: access_denied`, "has not completed the Google verification process" | The app is in Testing and your account is not a test user. Add it under **OAuth consent screen → Audience → Test users**, and sign in with that exact account. |
| Google: "app sent an invalid request" / `Error 400: invalid_request` | Open **error details** on that page for the offending parameter. Usually a wrong or truncated `GOOGLE_CLIENT_ID`, or an OAuth client that is not type **Web application**. |
| Connections page: "Google Analytics Admin API has not been used in project … or it is disabled" | Enable **Google Analytics Admin API** (step 2), wait a minute, reload the page. The sign-in is kept, so you do not need to connect again. |
| Sync error mentioning the Analytics **Data** API | Enable **Google Analytics Data API** (step 2). |
| "Google did not return a refresh token" | You approved this app before without a refresh token. Remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again. |
| "Analytics read access was not granted" | You unticked the Analytics permission on the consent screen. Connect again and leave it ticked, and make sure the scope is listed under Data Access. |
| "needs reconnect" some days later | The refresh token was revoked or, in Testing mode, expired after about 7 days. Click **Reconnect** (or publish the app, see above). |
| The property picker is empty | The Google account you signed in with has no GA4 property access. Sign in with the account that does (Analytics → Admin → Property access management). |
| Meta: "URL blocked" / redirect error | The URI is missing from **Facebook Login → Settings → Valid OAuth Redirect URIs**, or Client OAuth Login is switched off there. |
| Meta: you cannot sign in or see "app not active" | The app is in Development mode and your account has no role on it (**App roles**), or it needs the Marketing API product. |
| Meta: ad account list is empty | Your Facebook user has no access to an ad account. Add your user to it in Business settings → Ad accounts. |
| Connections says a provider is "not configured on the server" | The matching `*_CLIENT_ID` / `*_APP_ID` and secret are missing in `apps/api/.env.local`, or the API was not restarted after adding them. |
| After connecting, GA4 shows few or no campaigns | GA4 only has campaign data for traffic tagged with `utm_campaign`. See the notes below. |

### Notes and limits

- GA4 only has campaign data for traffic tagged with `utm_campaign`. "(not set)" and organic traffic are skipped (each sync reports how many rows were skipped and why).
- GA4 has no spend or impressions, so its rows are stored as separate campaigns named `… (GA4)`. They are not reconciled with Meta rows, so totals across both would double count.
- Meta `clicks` counts all clicks, and spend stays in the ad account's currency.
- Meta conversions count exactly one action type (purchase or lead, chosen when connecting) to avoid double counting.

### Handling secrets

- Put them only in `apps/api/.env.local` (git-ignored). Never in the Next.js app or any `NEXT_PUBLIC_` variable, and never in chats or issues.
- If one leaks, reset it in the provider's console and update `.env.local`.

---

## Actions and shadow mode

The agent can propose things to *do*, not just things to read. Everything goes through one gate: the approvals system. Every action is recorded (`GET /actions`). *The dashboard was simplified to three screens, so today it only exposes "Add to my to-do list"; pausing, budget changes and launch packages work through the API and can be given screens again.*

| Action | Where it comes from | Approval | What happens today |
|---|---|---|---|
| Add a task | "Add to my tasks" on any recommendation | none (internal, harmless) | Runs immediately; appears on **Tasks** |
| Pause a campaign | "Propose pausing" on a recommendation | required | Demo mode (default): **paused in the sandbox**. Shadow mode: recorded, not applied |
| Change a budget (max 10% at a time) | "Propose a budget change" | required | Demo mode (default): **changed in the sandbox**. Shadow mode: recorded, not applied |
| Publish a campaign | **Approve campaign** (Meta copy) | required (the Approve button is the approval) **Demo mode (the default): paused ads are created in the built-in ads sandbox.** With `EXECUTION_MODE=live` and posting allowed: paused ads are created on Meta. With `EXECUTION_MODE=shadow`: recorded, not applied |

**Shadow mode** (`EXECUTION_MODE=shadow`) is the first stage of the staged rollout in the original plan (read-only, then shadow, then approval, then limited autonomy). Your Meta and Google connections are read-only, so approving an external action records *exactly what would have happened* and changes nothing outside this app. The inbox says so before you decide, and Activity labels these "Recorded, not applied". `EXECUTION_MODE=live` does nothing extra yet: a real action type needs a live executor (one function in `apps/api/src/actions/actions.service.ts`) plus write permission on the platform, such as Meta `ads_management`. Until then it falls back to shadow and says why.

How it stays safe:
- Details are validated (typed, bounded) and a **preview of what would happen** is written when the action is proposed, so you approve something concrete.
- The action is **re-checked against current data when it runs**. If the campaign changed after you approved (for example it was paused meanwhile), the action fails instead of running.
- Each action is **claimed before it runs**, so approving twice, or two people approving at once, can never execute it twice. Identical proposals are not duplicated.
- Budget changes above 10%, pausing or re-budgeting a Google Analytics report, publishing an unapproved campaign, or scheduling in the past are refused.
- A rejected or failed action can be proposed again.

---

## Demo mode and the ads sandbox (the default)

`EXECUTION_MODE` picks where an approved campaign is posted:

| `EXECUTION_MODE` | Where approving posts | Needs |
|---|---|---|
| unset or `demo` (**default**) | The built-in **ads sandbox**: a pretend ad platform. No network calls, no login, nothing real is created and nothing can spend. | nothing |
| `live` | Your real Meta ad account (see below). | Meta connection with posting allowed |
| `shadow` | Nowhere: the approval is only recorded. | nothing |

In demo mode the sandbox behaves like a real platform: the same checks apply (daily budget between 1 and 50 USD, landing page must be https on one of your own websites, a Page must be chosen), ads are created **paused**, and a campaign cannot be posted twice. It creates one campaign and ad set plus one ad per variant on Meta, and one ad per variant for Google Ads (which the live mode cannot post yet). Approved **pause** requests mark the campaign paused in this app, and **budget changes** move a sandbox daily budget (starting from the budget the campaign was posted with, else its average daily spend, then building on the last change, always between 1 and 50 USD). The campaign page lists the pretend ad ids it created, and a **Demo mode** badge shows in the top bar. The live Meta code is unchanged and is used only when `EXECUTION_MODE=live`.

## Posting to Meta (live mode)

With `EXECUTION_MODE=live`, approving a campaign that has Facebook & Instagram copy creates the ads in your Meta ad account. It only ever creates things **paused**.

**What gets created:** one campaign (objective *Traffic*), one ad set (the daily budget and country you enter) and one ad per variant (A, B, …), each using that variant's own headline, description, post text and button. Links carry `utm_source/medium/campaign/content` tags so Google Analytics can attribute the visits. Nothing spends until *you* switch the ads on in Ads Manager. After creating them the app asks Meta to confirm each one really is paused (and pauses it if not).

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

---

## Tools

The assistant works only through these typed tools.

**Read tools** (look things up; every call is logged on the Tool history page):
- `list_campaigns`: lists your campaigns.
- `get_campaign_metrics`: daily numbers and totals for one campaign over a date range.
- `get_brand_guidelines`: your brand voice, approved claims, banned phrases and allowed domains.
- `get_product_information`: your products.
- `get_audience_segments`: your target audiences.

**Action tools** (change something; each shows a preview first):
- `create_task`: adds an item to your to-do list. No approval needed.
- `publish_campaign`: posts an approved campaign to Meta as paused ads (recorded only in shadow mode).
- `pause_campaign`: pauses a campaign. Needs approval; recorded only for now.
- `change_budget`: changes a daily budget by at most 10%. Needs approval; recorded only for now.

## Safety model

- Drafts, reports and internal tasks run automatically; sending, publishing, budget changes and pausing need human approval and, for now, are only recorded (shadow mode); deleting is never automatic.
- The model never computes numbers: metrics, comparisons and anomaly detection are deterministic code, and the model's cited values are validated against them.
- All data access goes through audited, workspace-scoped read tools.
- OAuth uses a single-use, expiring `state` (plus PKCE for Google); the workspace is recovered from that state, never from the callback URL.
- **Known gap:** there is no real user login yet. The dashboard identifies the workspace with a header (`x-workspace-id`), so anyone who can open the dashboard can connect accounts. Do not expose this app publicly.

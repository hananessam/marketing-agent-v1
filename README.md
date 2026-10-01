# Marketing Agent

An AI-assisted marketing workflow: it analyzes campaign performance, recommends next actions, and drafts campaigns. **It only drafts and recommends. Nothing is published, sent, or spent without human approval.**

- **Analytics:** compares the last period with the one before, checks data quality, detects anomalies, and proposes up to three actions backed by cited metrics.
- **Campaign drafting:** plan + content variants, checked against brand policy (prohibited phrases, unsupported claims, link domains/UTMs, length limits).
- **Approvals:** every risky action waits in an inbox; every tool call is audited.
- **Background jobs:** scheduled reports (BullMQ + Redis), optional Slack summaries.
- **Connectors:** Meta Ads and Google Analytics 4 (read-only) instead of seeded data.

## Layout

```
apps/web          Next.js dashboard (App Router, TanStack Query)
apps/api          NestJS API, LangGraph workflows (OpenAI), Drizzle + SQLite
packages/shared   Zod schemas, metrics math, approval policy
```

## Quick start

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

## Environment variables

Put these in `apps/api/.env.local` (git-ignored). **Never commit them or paste them into chats or issues.** Web-only settings go in `apps/web/.env.local`.

| Variable | Needed for |
|---|---|
| `OPENAI_API_KEY` | Analysis and drafting (required) |
| `OPENAI_MODEL` | Optional, default `gpt-4.1-mini` |
| `DATABASE_URL` | Optional, default `local.db` |
| `REDIS_URL` | Schedules and background jobs |
| `SLACK_WEBHOOK_URL` | Optional Slack report summaries (`https://hooks.slack.com/...` only) |
| `CONNECTOR_ENCRYPTION_KEY` | Encrypting stored connector credentials |
| `META_*`, `GA4_*` | Connectors, see below |

---

## Getting credentials

All connectors are **read-only**. Credentials are stored AES-256-GCM encrypted per workspace, are never returned by the API, and are never accepted over HTTP.

### 1. Encryption key (required for any connector)

```bash
openssl rand -base64 32
```

Save the output as `CONNECTOR_ENCRYPTION_KEY=...`. Back it up: without it, stored connections cannot be decrypted.

### 2. Meta Ads (needs the `ads_read` permission)

**Recommended: a System User token**, which does not expire every 60 days.

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**. Choose the **Business** type and link your Business portfolio.
2. Open [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System users → Add** (Employee role).
3. Select the system user → **Assign assets → Ad accounts** → choose your ad account with **View performance** only (read-only).
4. Click **Generate new token**, pick your app, tick only **`ads_read`**, and set expiry to **Never**. Copy it once.
5. Get the ad account id from Business settings → **Accounts → Ad accounts**. The `act_` prefix is added automatically.

```
META_ACCESS_TOKEN=...
META_AD_ACCOUNT_ID=act_1234567890
META_CONVERSION_ACTION=purchase     # or "lead"; exactly one action type is counted
```

*Quick test alternative:* in [Graph API Explorer](https://developers.facebook.com/tools/explorer) choose your app, add `ads_read`, and generate a token. It lasts only an hour or two.

### 3. Google Analytics 4 (service account)

1. In [Google Cloud Console](https://console.cloud.google.com), create or select a project → **APIs & Services → Library** → enable **Google Analytics Data API**.
2. **IAM & Admin → Service Accounts → Create service account** (no roles needed). Open it → **Keys → Add key → Create new key → JSON**.
3. Move the downloaded file **outside this repo** (for example `~/.secrets/ga4-key.json`) and run `chmod 600` on it.
4. Copy `client_email` from the JSON. In [analytics.google.com](https://analytics.google.com) go to **Admin → Property access management → +** and add that email with the **Viewer** role.
5. The property id is under **Admin → Property details** (a number).

```
GA4_PROPERTY_ID=123456789
GA4_SERVICE_ACCOUNT_FILE=/Users/you/.secrets/ga4-key.json
```

If key creation is blocked, a Workspace policy (`iam.disableServiceAccountKeyCreation`) is probably enforced; an org admin must lift it.

### 4. Connect and sync

```bash
pnpm --filter api connect meta_ads --workspace ws_demo --days 30
pnpm --filter api connect ga4      --workspace ws_demo --days 30
# add --purge-seed to remove the demo-seed campaigns once real data is in
```

The command runs a real read-only pull first and stores the connection only if it works. Secrets are never printed.

**Notes and limits**
- GA4 only has campaign data for traffic tagged with `utm_campaign`. "(not set)" and organic traffic are skipped (the sync reports how many rows were skipped and why).
- GA4 has no spend or impressions, so its rows are stored as separate campaigns named `… (GA4)`. They are not reconciled with Meta rows, so totals across both would double count.
- Meta `clicks` counts all clicks, and spend stays in the ad account's currency.

---

## Planned: "Connect with Google / Meta" (OAuth)

Not built yet. Instead of a service-account key or a pasted token, the user would click **Connect** in the dashboard and sign in. This needs **app-level** credentials that identify *your app* to Google and Meta (users never see or type them).

| Variable | Why |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Identify the app in Google's consent screen and prove the code exchange comes from your server |
| `META_APP_ID` / `META_APP_SECRET` | Identify the app in the Facebook Login dialog; exchange the code for a long-lived token |
| `API_PUBLIC_URL` | Builds the redirect URIs; must match the console registration exactly. Defaults to `http://localhost:4000` locally |

### Google: client id and secret

1. [Google Cloud Console](https://console.cloud.google.com) → create or select a project.
2. **APIs & Services → Library**: enable **Google Analytics Data API** and **Google Analytics Admin API** (the latter lets users pick a property from a list).
3. **OAuth consent screen** (or "Google Auth Platform"): user type **External** (or Internal on a Workspace org); fill in the app name and your email; add the scope `https://www.googleapis.com/auth/analytics.readonly`. While in **Testing**, add your Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID** → **Web application**. Add the authorized redirect URI exactly: `http://localhost:4000/connections/google/callback`. Copy the **Client ID** and **Client secret**.

```
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> In **Testing** status, refresh tokens can expire after about 7 days. Click **Publish app** for longer use (personal use under about 100 users shows an "unverified app" warning you can click through).

### Meta: app id and secret

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → **Business** type.
2. Add the **Marketing API** product and **Facebook Login for Business** (or Facebook Login).
3. **App settings → Basic**: copy the **App ID**; click Show next to **App Secret**.
4. **Facebook Login → Settings**: add `http://localhost:4000/connections/meta/callback` to **Valid OAuth Redirect URIs**.
5. Keep the app in **Development** mode. People with a role on the app (**App roles**) can authorize `ads_read` for their own ad accounts; anyone else needs Meta's App Review.

```
META_APP_ID=1234567890
META_APP_SECRET=...
```

> Meta has no refresh tokens: a long-lived token lasts about 60 days, then the user reconnects. A System User token (section 2 above) is better for unattended servers.

### Handling secrets

- Put them only in `apps/api/.env.local`. Never in the Next.js app or any `NEXT_PUBLIC_` variable.
- If one leaks, reset it in the provider's console and update `.env.local`.

---

## Safety model

- Drafts and reports run automatically; sending, publishing, budget changes and pausing need human approval; deleting is never automatic.
- The model never computes numbers: metrics, comparisons and anomaly detection are deterministic code, and the model's cited values are validated against them.
- All data access goes through audited, workspace-scoped read tools.
- **Known gap:** there is no real authentication yet. The dashboard identifies the workspace with a header (`x-workspace-id`), so do not expose this API publicly.

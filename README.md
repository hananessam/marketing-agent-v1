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
| `CONNECTOR_ENCRYPTION_KEY` | Encrypting stored OAuth tokens |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Connect Google Analytics" |
| `META_APP_ID`, `META_APP_SECRET` | "Connect Meta Ads" |
| `API_PUBLIC_URL` | Optional, default `http://localhost:4000`; used to build OAuth redirect URIs |
| `WEB_ORIGIN` | Optional, default `http://localhost:3000`; where users return after signing in |

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

1. [Google Cloud Console](https://console.cloud.google.com) → create or select a project.
2. **APIs & Services → Library**: enable **Google Analytics Data API** and **Google Analytics Admin API** (the latter lets users pick a property from a list).
3. **OAuth consent screen** (or "Google Auth Platform"): user type **External** (or Internal on a Workspace org); fill in the app name and your email; add the scope `https://www.googleapis.com/auth/analytics.readonly`. While in **Testing**, add your Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID** → **Web application**. Add the authorized redirect URI exactly: `http://localhost:4000/connections/oauth/google/callback`. Copy the **Client ID** and **Client secret**.

```
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> In **Testing** status, refresh tokens can expire after about 7 days and the connection will show "needs reconnect". Click **Publish app** for longer use (personal use under about 100 users shows an "unverified app" warning you can click through).

### 3. Meta: app id and secret

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → **Business** type.
2. Add the **Marketing API** product and **Facebook Login for Business** (or Facebook Login).
3. **App settings → Basic**: copy the **App ID**; click Show next to **App Secret**.
4. **Facebook Login → Settings**: add `http://localhost:4000/connections/oauth/meta/callback` to **Valid OAuth Redirect URIs**.
5. Keep the app in **Development** mode. People with a role on the app (**App roles**) can authorize `ads_read` for their own ad accounts; anyone else needs Meta's App Review.

```
META_APP_ID=1234567890
META_APP_SECRET=...
```

> Meta has no refresh tokens: a login lasts about 60 days. The Connections page shows the expiry and a **Reconnect** button.

### 4. Connect

Restart the API, open **Connections**, click **Connect** on a provider, sign in, pick the GA4 property or ad account, and the first 30 days are pulled. Use **Sync now** to refresh, and **Remove demo data** once real data is in.

When you deploy, set `API_PUBLIC_URL` to your HTTPS URL and update the redirect URIs in both consoles to match exactly.

### Notes and limits

- GA4 only has campaign data for traffic tagged with `utm_campaign`. "(not set)" and organic traffic are skipped (each sync reports how many rows were skipped and why).
- GA4 has no spend or impressions, so its rows are stored as separate campaigns named `… (GA4)`. They are not reconciled with Meta rows, so totals across both would double count.
- Meta `clicks` counts all clicks, and spend stays in the ad account's currency.
- Meta conversions count exactly one action type (purchase or lead, chosen when connecting) to avoid double counting.

### Handling secrets

- Put them only in `apps/api/.env.local` (git-ignored). Never in the Next.js app or any `NEXT_PUBLIC_` variable, and never in chats or issues.
- If one leaks, reset it in the provider's console and update `.env.local`.

---

## Safety model

- Drafts and reports run automatically; sending, publishing, budget changes and pausing need human approval; deleting is never automatic.
- The model never computes numbers: metrics, comparisons and anomaly detection are deterministic code, and the model's cited values are validated against them.
- All data access goes through audited, workspace-scoped read tools.
- OAuth uses a single-use, expiring `state` (plus PKCE for Google); the workspace is recovered from that state, never from the callback URL.
- **Known gap:** there is no real user login yet. The dashboard identifies the workspace with a header (`x-workspace-id`), so anyone who can open the dashboard can connect accounts. Do not expose this app publicly.

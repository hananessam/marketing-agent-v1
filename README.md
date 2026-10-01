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

## Safety model

- Drafts and reports run automatically; sending, publishing, budget changes and pausing need human approval; deleting is never automatic.
- The model never computes numbers: metrics, comparisons and anomaly detection are deterministic code, and the model's cited values are validated against them.
- All data access goes through audited, workspace-scoped read tools.
- OAuth uses a single-use, expiring `state` (plus PKCE for Google); the workspace is recovered from that state, never from the callback URL.
- **Known gap:** there is no real user login yet. The dashboard identifies the workspace with a header (`x-workspace-id`), so anyone who can open the dashboard can connect accounts. Do not expose this app publicly.

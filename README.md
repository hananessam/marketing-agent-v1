# Marketing Agent

An AI-assisted marketing workflow: it analyzes campaign performance, recommends what to do next, and drafts Google Ads and Meta (Facebook & Instagram) ad campaigns.

**It only drafts and recommends. Nothing real is published or spent without your approval, and out of the box nothing leaves your machine except the calls to OpenAI.**

## Run it

You need [Node.js](https://nodejs.org) 20 or newer (it includes npm) and an [OpenAI API key](https://platform.openai.com/api-keys). Run each command from the project folder, one after the other.

**1. Install the packages**

```bash
npm install
```

**2. Build the shared code**

```bash
npm run build:shared
```

**3. Create the settings file**

```bash
cp -n .env.example apps/api/.env.local
```

**4. Put your OpenAI key in the settings file**: open `apps/api/.env.local` and set the line `OPENAI_API_KEY=` to your key, for example `OPENAI_API_KEY=sk-...`

**5. Create the database**

```bash
npm run db:push
```

**6. Load the demo data**

```bash
npm run seed
```

**7. Start the API** (leave this terminal open)

```bash
npm run dev:api
```

**8. Start the web app** (in a second terminal, from the project folder)

```bash
npm run dev:web
```

**9. Open the app**

```
http://localhost:3000
```

Without the OpenAI key the app still opens and shows the demo data, but the parts that need the AI (checking your numbers, writing drafts) will tell you the key is missing.

## Run it with Docker instead

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine with Compose v2). You don't need Node.js for this route, so skip the steps above.

**1. Create the settings file**

```bash
cp -n .env.example apps/api/.env.local
```

**2. Put your OpenAI key in the settings file**: open `apps/api/.env.local` and set the line `OPENAI_API_KEY=` to your key.

**3. Build and start everything**

```bash
docker compose up --build
```

**4. Open the app**

```
http://localhost:3000
```

**To stop it** (your data is kept)

```bash
docker compose down
```

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
- `publish_campaign`: posts an approved campaign as paused ads (to the demo sandbox by default, to Meta in live mode).
- `pause_campaign`: pauses a campaign. Needs approval.
- `change_budget`: changes a daily budget by at most 10%. Needs approval.

## Demo, live or record-only

`EXECUTION_MODE` in `apps/api/.env.local` decides where an approved campaign goes:

| Value | What happens |
|---|---|
| unset or `demo` (default) | Posted to a built-in pretend ad platform. No login, no network, nothing real. |
| `live` | Creates paused ads in your real Meta ad account (see [live posting](docs/live-posting.md)). |
| `shadow` | Only records what would have been posted. |

## Go further

- [Connect your real Google Analytics and Meta accounts](docs/connecting-accounts.md): the OAuth setup, step by step, with troubleshooting.
- [Post real ads to Meta](docs/live-posting.md)
- [All settings and environment variables](docs/configuration.md): Redis schedules, Slack summaries, budget limits and more.
- [Modes, actions and approvals](docs/modes-and-actions.md)
- [More Docker details](docs/docker.md): blank start, logs, deleting the data, and what the containers do.

## Safety

- Drafts, reports and internal tasks run automatically; publishing, budget changes and pausing need your approval; deleting is never automatic.
- The AI never computes numbers: metrics, comparisons and anomaly detection are plain code, and every figure the AI cites is checked against them.
- All data access goes through audited, workspace-scoped tools.
- **Known gap:** there is no real user login yet, so anyone who can open the dashboard can use it and connect accounts. Do not expose this app publicly.

## Project layout

```
apps/web          Next.js dashboard
apps/api          NestJS API, LangGraph workflows (OpenAI), SQLite
packages/shared   Zod schemas, metrics math, approval policy
```

Other commands: `npm test`, `npm run typecheck`. After changing `packages/shared`, run `npm run build:shared`.

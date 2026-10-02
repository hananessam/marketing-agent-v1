# Marketing Agent

An AI-assisted marketing workflow: it analyzes campaign performance, recommends what to do next, and drafts Google Ads and Meta (Facebook & Instagram) ad campaigns.

**It only drafts and recommends. Nothing real is published or spent without your approval, and out of the box nothing leaves your machine except the calls to OpenAI.**

## Run it

You need [Node.js](https://nodejs.org) 20 or newer, [pnpm](https://pnpm.io/installation) (`corepack enable` is the easy way to get it) and an [OpenAI API key](https://platform.openai.com/api-keys). From the project folder:

```bash
pnpm install
pnpm build:shared
cp -n .env.example apps/api/.env.local   # open this file and set OPENAI_API_KEY=sk-...
pnpm db:push && pnpm seed                # creates the database and loads demo data
pnpm dev:api                             # terminal 1 -> http://localhost:4000
pnpm dev:web                             # terminal 2 -> http://localhost:3000
```

Open **http://localhost:3000**.

Without the OpenAI key the app still opens and shows the demo data, but the parts that need the AI (checking your numbers, writing drafts) will tell you the key is missing.

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
- [Run everything with Docker](docs/docker.md)

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

Other commands: `pnpm test`, `pnpm typecheck`. After changing `packages/shared`, run `pnpm build:shared`.

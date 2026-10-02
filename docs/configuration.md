# Environment variables

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
| `EXECUTION_MODE` | Optional, default `demo`: **Approve campaign** posts to a built-in ads sandbox and nothing real changes. `live` creates paused ads on Meta (see [live posting](live-posting.md)). `shadow` only records what would be posted |
| `MAX_DAILY_BUDGET` | Optional, default `50`. Hard ceiling on the daily budget this app will ever set on an ad, whatever is typed into a form |
| `SYNC_CRON`, `SYNC_TIMEZONE` | Optional daily connector sync time, default `0 5 * * *` in `UTC`. At most hourly; invalid values fall back to the default |

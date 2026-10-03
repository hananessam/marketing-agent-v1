# Run everything with Docker

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

After you change `apps/api/src/db/schema.ts`, generate a migration so the Docker database gets it: `npm run db:generate -w api`, then commit the new file in `apps/api/drizzle/`. (`npm run db:push` is only for the local dev database.)

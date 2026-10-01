#!/bin/sh
set -e

node dist/db/migrate.js

# Demo data is loaded once per data volume (the seed script wipes existing data, so never repeat it).
if [ "${SEED_DEMO:-false}" = "true" ] && [ ! -f /data/.seeded ]; then
  ./node_modules/.bin/tsx scripts/seed.ts
  touch /data/.seeded
fi

exec node dist/main.js

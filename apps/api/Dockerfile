# Build context is the repo root: docker compose build api
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# better-sqlite3 compiles a native module when no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @marketing/shared build && pnpm --filter api build

FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
# SQLite lives on a volume so data survives container rebuilds
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
CMD ["sh", "docker-entrypoint.sh"]

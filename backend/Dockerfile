# EdgeProbe backend — Fly.io production image.
#
# Single-stage Bun on Debian slim. Multi-stage gives us maybe 40 MB savings
# on a ~150 MB image — not worth the complexity for a staging backend.
#
# Build context is `backend/` — the deploy workflow cd's there before
# calling `flyctl deploy`, and fly.toml is colocated.
#
# What's in the image:
#   /app/package.json, bun.lock      — production dep manifest
#   /app/bunfig.toml                  — test-only (harmless in prod)
#   /app/src/**                       — source, including src/migrations/*.sql
#   /app/node_modules/**              — production deps (bun install --production)
#
# Runtime wants:
#   DATABASE_URL, SHARE_TOKEN_SECRET, BOOTSTRAP_API_KEYS  (via `fly secrets set`)
#   PORT                                                   (Fly injects; falls back to 3000)

FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Copy manifests first so `bun install` caches across source-only changes.
COPY package.json bun.lock ./

# --production skips devDependencies (typescript, @types/bun). --frozen-lockfile
# fails the build on lockfile drift — we want that; silent drift is how staging
# diverges from local.
RUN bun install --production --frozen-lockfile

# Source + bunfig. bunfig.toml is test-scoped so prod ignores it; copying
# it in is harmless and keeps `bun test` runnable inside the image if we
# ever need to debug from within.
COPY src ./src
COPY bunfig.toml ./

ENV NODE_ENV=production
EXPOSE 3000

# Fly's internal health check (configured in fly.toml) handles liveness —
# we don't add a Docker HEALTHCHECK because that'd require `curl` in the
# image and the two mechanisms would duplicate.

CMD ["bun", "run", "src/server.ts"]

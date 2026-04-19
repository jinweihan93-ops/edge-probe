# EdgeProbe web dashboard — Fly.io production image.
#
# Single-stage Bun on Debian slim, same pattern as backend/Dockerfile. Web is
# a stateless SSR renderer (Hono + hono/jsx), so the image is smaller and has
# no migrations to run — it just forwards requests to BACKEND_URL.
#
# Build context is `web/` — the deploy workflow cd's there before calling
# `flyctl deploy`, and fly.toml is colocated.
#
# What's in the image:
#   /app/package.json, bun.lock      — production dep manifest
#   /app/src/**                       — Hono app, JSX pages, backend client
#   /app/public/**                    — fonts + tokens.css (served via serveStatic)
#   /app/node_modules/**              — production deps (hono)
#
# Runtime wants:
#   BACKEND_URL     (e.g. https://edgeprobe-staging.fly.dev) — set via `fly secrets set`
#   PORT            (Fly injects; falls back to 3001)
#
# NOTE on cross-package imports: `src/lib/backend.ts` does
#   `import type { PublicTraceView } from "../../../backend/src/views.ts"`
# which is TYPE-ONLY — Bun erases it at runtime, so we do NOT need to copy
# backend/ into this image. If that import ever becomes runtime, the build
# will break loudly (good — we want to know).

FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Copy manifests first so `bun install` caches across source-only changes.
COPY package.json bun.lock ./

# --production skips devDependencies (@types/bun, typescript). --frozen-lockfile
# catches lockfile drift — don't let staging silently diverge from local.
RUN bun install --production --frozen-lockfile

# Source + static assets + tsconfig (JSX needs `jsxImportSource: hono/jsx`
# from tsconfig.json — without it, Bun defaults to react/jsx-runtime and the
# container crashes with `Cannot find module 'react/jsx-runtime'`).
COPY src ./src
COPY public ./public
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3001

# Fly's internal health check (configured in fly.toml) handles liveness.
CMD ["bun", "run", "src/server.tsx"]

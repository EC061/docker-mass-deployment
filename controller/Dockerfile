# Controller image: builds the Next.js app and runs the long-lived custom server (Next + WS hub).
# Multi-stage to keep the runtime image lean while still compiling native modules during build.

# Base image pinned by digest for reproducible, tamper-evident builds (M-09). Dependabot bumps the
# digest; the tag comment keeps it readable.
FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS deps
WORKDIR /app
# Build tools for native modules (better-sqlite3 / honker-node) if no prebuild is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Non-root runtime user.
RUN useradd --create-home --uid 10001 app
# COPY --chown sets ownership inline during extraction. A separate `chown -R app:app /app` instead
# rewrites every node_modules file into a fresh ~hundreds-of-MB layer (~90s on arm64) and bloats the
# image — so set ownership at copy time and only chown the writable data dir afterwards.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/next.config.js ./next.config.js
COPY --from=build --chown=app:app /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=app:app /app/server.ts ./server.ts
COPY --from=build --chown=app:app /app/src ./src
# DB lives on a mounted volume; only this dir is written at runtime.
RUN mkdir -p /app/data && chown app:app /app /app/data
USER app
EXPOSE 8443
# Invoke the tsx binary that's already in node_modules rather than `npx tsx`, which can reach out to
# the network to fetch a missing package at boot (L-07).
CMD ["node_modules/.bin/tsx", "server.ts"]

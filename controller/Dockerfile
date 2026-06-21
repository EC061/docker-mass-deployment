# Controller image: builds the Next.js app and runs the long-lived custom server (Next + WS hub).
# Multi-stage to keep the runtime image lean while still compiling native modules during build.

# Base image pinned by digest for reproducible, tamper-evident builds (M-09). Dependabot bumps the
# digest; the tag comment keeps it readable.
FROM node:26-bookworm-slim@sha256:4e2e85a824f938e41a61e9e819f0c7c11432f7d60f470b96214d3ead2f0dd63e AS deps
WORKDIR /app
# Build tools for native modules (better-sqlite3 / honker-node) if no prebuild is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:26-bookworm-slim@sha256:4e2e85a824f938e41a61e9e819f0c7c11432f7d60f470b96214d3ead2f0dd63e AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:26-bookworm-slim@sha256:4e2e85a824f938e41a61e9e819f0c7c11432f7d60f470b96214d3ead2f0dd63e AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Non-root runtime user.
RUN useradd --create-home --uid 10001 app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.js ./next.config.js
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src
# DB lives on a mounted volume.
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 8443
# Invoke the tsx binary that's already in node_modules rather than `npx tsx`, which can reach out to
# the network to fetch a missing package at boot (L-07).
CMD ["node_modules/.bin/tsx", "server.ts"]

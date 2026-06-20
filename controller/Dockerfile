# Controller image: builds the Next.js app and runs the long-lived custom server (Next + WS hub).
# Multi-stage to keep the runtime image lean while still compiling native modules during build.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Build tools for native modules (better-sqlite3 / honker-node) if no prebuild is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
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
CMD ["npx", "tsx", "server.ts"]

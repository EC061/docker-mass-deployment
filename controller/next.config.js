/** @type {import('next').NextConfig} */

// Server Actions are CSRF-protected by comparing the request Origin to the Host. Behind a
// TLS-terminating reverse proxy the internal Host (e.g. controller:8443) differs from the public
// domain, so the check rejects every action unless the public domain is allow-listed here.
// CONTROLLER_DOMAIN pins that ONE domain (host only — no scheme, port, path, wildcard, or comma list).
// Authoritative validation with a clear error happens at server boot (assertEnv in lib/env.ts); this
// keeps a defensive copy so a malformed value never widens the allow-list. Unset → same-origin only.
const raw = (process.env.CONTROLLER_DOMAIN ?? "").trim();
const looksValid =
  raw !== "" && !/[,/*\s]/.test(raw) && !raw.includes("://") && !raw.includes(":");
const allowedOrigins = looksValid ? [raw] : [];

const nextConfig = {
  reactStrictMode: true,
  // Keep Turbopack scoped to this app. Without an explicit root, a stray lockfile in a parent
  // directory can make Next choose the wrong workspace and emit warnings.
  turbopack: { root: import.meta.dirname },
  // better-sqlite3 and honker-node are native modules — keep them external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "@russellthehippo/honker-node"],
  ...(allowedOrigins.length > 0 && {
    experimental: { serverActions: { allowedOrigins } },
  }),
};

export default nextConfig;

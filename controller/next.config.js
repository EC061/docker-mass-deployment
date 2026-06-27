/** @type {import('next').NextConfig} */

// Server Actions are CSRF-protected by comparing the request Origin to the Host. Behind a
// TLS-terminating reverse proxy the internal Host (e.g. controller:8443) differs from the public
// domain, so the check rejects every action unless the public domain is allow-listed here.
// CONTROLLER_DOMAIN pins that domain (host only, no scheme) — set it in compose for any deployment
// reached through a proxy or under a real hostname. Comma-separated to allow more than one; a leading
// wildcard label is supported (e.g. "lab.cs.uga.edu" or "*.cs.uga.edu"). Unset → same-origin only.
const allowedOrigins = (process.env.CONTROLLER_DOMAIN ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 and honker-node are native modules — keep them external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "@russellthehippo/honker-node"],
  ...(allowedOrigins.length > 0 && {
    experimental: { serverActions: { allowedOrigins } },
  }),
};

export default nextConfig;

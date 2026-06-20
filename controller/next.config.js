/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 and honker-node are native modules — keep them external to the server bundle.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "@russellthehippo/honker-node"],
  },
};

export default nextConfig;

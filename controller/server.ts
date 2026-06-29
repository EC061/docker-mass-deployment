/**
 * Long-lived custom Node server: hosts the Next.js app AND the agent WebSocket hub on one port.
 *
 * Next cannot run the hub in serverless mode, so the controller is always deployed as this process
 * (dev: `tsx watch server.ts`; prod/Docker: `tsx server.ts`).
 */

// Must stay first: sets globalThis.AsyncLocalStorage before any `next` module loads (see node-env.ts).
import "./src/lib/node-env";
import { createServer } from "node:http";
import next from "next";
import { attachHub } from "./src/lib/hub";
import { assertEnv, env } from "./src/lib/env";
import { db } from "./src/lib/db";
import { startMaintenance } from "./src/lib/maintenance";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  // Validate bootstrap env eagerly so a misconfigured deploy fails closed with a precise message
  // (missing/placeholder/weak secrets, bad PORT, malformed CONTROLLER_DOMAIN) before serving anything.
  assertEnv();
  // Open + migrate the DB at boot so the first request isn't slowed and schema errors surface early.
  db();
  await app.prepare();

  const server = createServer((req, res) => handle(req, res));
  attachHub(server, "/agent");
  startMaintenance();

  server.listen(env.port, () => {
    console.log(`controller listening on :${env.port} (agent WS at ws(s)://<host>:${env.port}/agent)`);
  });
}

main().catch((err) => {
  console.error("controller failed to start", err);
  process.exit(1);
});

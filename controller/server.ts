/**
 * Long-lived custom Node server: hosts the Next.js app AND the agent WebSocket hub on one port.
 *
 * Next cannot run the hub in serverless mode, so the controller is always deployed as this process
 * (dev: `tsx watch server.ts`; prod/Docker: `tsx server.ts`).
 */

import { createServer } from "node:http";
import next from "next";
import { attachHub } from "./src/lib/hub";
import { env } from "./src/lib/env";
import { db } from "./src/lib/db";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  // Open + migrate the DB at boot so the first request isn't slowed and schema errors surface early.
  db();
  await app.prepare();

  const server = createServer((req, res) => handle(req, res));
  attachHub(server, "/agent");

  server.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`controller listening on :${env.port} (agent WS at ws(s)://<host>:${env.port}/agent)`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("controller failed to start", err);
  process.exit(1);
});

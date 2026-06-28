/**
 * WebSocket hub: the controller side of the agent connection.
 *
 * Agents dial in (outbound from their network) and authenticate with a hello frame. Once a node is
 * registered, a per-node consumer loop claims tasks from that node's honker queue and pushes them
 * down the socket. Inbound result/log/event/telemetry frames are persisted.
 *
 * This runs inside the long-lived custom Node server (server.ts), not in a Next request handler.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { alertNodeOffline, alertTaskFailed, maybeAlertOnLog } from "./alerts";
import { db } from "./db";
import { ingestTelemetry, storeOldfileScan } from "./ingest";
import { markLabStatus } from "./labs";
import { verifyNodeAuth } from "./nodes";
import { ackTask, claimTask, markTaskState, retryTask } from "./queue";
import { getSetting } from "./settings";

interface NodeConn {
  ws: WebSocket;
  node: string;
  consumer: NodeJS.Timeout;
}

const connections = new Map<string, NodeConn>();
// Pending offline-alert timers, keyed by node. A disconnect schedules one; a reconnect within the
// grace window cancels it, so transient blips (agent restart, brief network drop) never page admins.
const pendingOfflineAlerts = new Map<string, NodeJS.Timeout>();
const WORKER_PREFIX = "controller-hub";

/** Cancel any pending offline alert for a node (it came back before the grace window elapsed). */
function cancelOfflineAlert(node: string): void {
  const t = pendingOfflineAlerts.get(node);
  if (t) {
    clearTimeout(t);
    pendingOfflineAlerts.delete(node);
  }
}

export function connectedNodes(): string[] {
  return [...connections.keys()];
}

/** Push an arbitrary frame to a connected node (used for out-of-band control if needed). */
export function sendToNode(node: string, frame: unknown): boolean {
  const conn = connections.get(node);
  if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
  conn.ws.send(JSON.stringify(frame));
  return true;
}

// Frame ceiling: legitimate telemetry/log frames are a few KiB; cap well below the ws default
// (~100 MiB) so one oversized frame can't balloon memory (M-02). Matches the agent's 8 MiB send cap.
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB
// Per-connection message-rate cap: a token bucket refilling at RATE msgs/sec up to BURST.
const MSG_RATE_PER_SEC = 50;
const MSG_BURST = 100;

export function createHub(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  wss.on("connection", (ws: WebSocket) => {
    let node: string | null = null;
    let tokens = MSG_BURST;
    let lastRefill = Date.now();

    ws.on("message", (raw) => {
      // Refill the bucket, then spend one token per message; flooding closes the socket.
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - lastRefill) / 1000) * MSG_RATE_PER_SEC);
      lastRefill = now;
      if (tokens < 1) {
        ws.close(4008, "rate limit exceeded");
        return;
      }
      tokens -= 1;

      let frame: any;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame.type === "hello") {
        node = handleHello(ws, frame);
        return;
      }
      if (!node) return; // ignore everything until authenticated
      ingestFrame(node, frame);
    });

    ws.on("close", () => {
      if (node) deregisterNode(node);
    });
    ws.on("error", () => {
      if (node) deregisterNode(node);
    });
  });

  return wss;
}

function handleHello(ws: WebSocket, frame: any): string | null {
  const node = String(frame.node ?? "");
  // Per-node identity: name must be on the allow-list AND the credential must verify (C-04, M-03).
  const auth = verifyNodeAuth(node, String(frame.token ?? ""));
  if (!auth.ok) {
    ws.close(4001, auth.reason ?? "unauthorized");
    return null;
  }

  // Do NOT let a newcomer steal a live node's queue. Only supersede a dead/closing socket; a real
  // duplicate is refused. A genuinely half-open peer is closed by the 20s ws ping timeout, after
  // which its slot frees and the agent reconnects normally.
  const existing = connections.get(node);
  if (existing && existing.ws.readyState === existing.ws.OPEN) {
    ws.close(4003, "node already connected");
    return null;
  }
  if (existing) {
    clearInterval(existing.consumer);
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
  }

  registerNode(node, frame.capabilities ?? {});
  const consumer = setInterval(() => drainNode(node, ws), 400);
  connections.set(node, { ws, node, consumer });
  return node;
}

function drainNode(node: string, ws: WebSocket): void {
  if (ws.readyState !== ws.OPEN) return;
  const workerId = `${WORKER_PREFIX}-${node}`;
  // Send a small batch per tick to avoid hogging the loop.
  for (let i = 0; i < 20; i++) {
    const claimed = claimTask(node, workerId);
    if (!claimed) break;
    try {
      ws.send(JSON.stringify(claimed.frame));
      ackTask(node, claimed.jobId, workerId);
      markTaskState(node, claimed.frame.id, "sent");
    } catch {
      retryTask(node, claimed.jobId, workerId, "send failed");
      break;
    }
  }
}

// ----------------------------------------------------------------- ingestion

function ingestFrame(node: string, frame: any): void {
  switch (frame.type) {
    case "result":
      handleResult(node, frame);
      break;
    case "log":
      handleLog(node, frame);
      break;
    case "event":
      handleEvent(node, frame);
      break;
    case "telemetry":
      handleTelemetry(node, frame);
      break;
    default:
      break;
  }
}

function handleResult(node: string, frame: any): void {
  // Bind the result to the node the task was queued for. A foreign/unknown UUID matches no row, so a
  // spoofing agent can't complete, fail, or poison another node's task (H-03). Drop it silently.
  const changed = markTaskState(
    node,
    frame.id,
    frame.ok ? "ok" : "failed",
    frame.result,
    frame.ok ? undefined : frame.error,
  );
  if (!changed) return;
  const t = db()
    .prepare("SELECT node, action, params FROM task_log WHERE task_uuid = ?")
    .get(frame.id) as { node: string; action: string; params: string | null } | undefined;
  if (!frame.ok && t) {
    alertTaskFailed(t.node, t.action, frame.error ?? "unknown error");
  }
  // Lab provisioning lifecycle: a lab is created in 'provisioning' and stays there until its
  // lab.create task reports back. Flip it to 'active' on success or 'failed' on error so it no
  // longer reads as permanently "provisioning". The lab name comes from the task params (the result
  // payload also carries it, but params is always present even on failure).
  if (t?.action === "lab.create") {
    let labName: string | undefined = frame.result?.lab;
    if (!labName && t.params) {
      try {
        labName = (JSON.parse(t.params) as { lab?: string }).lab;
      } catch {
        labName = undefined;
      }
    }
    if (labName) markLabStatus(labName, frame.ok ? "active" : "failed");
  }
  // Persist scan results into the oldfile_scans table.
  if (frame.ok && frame.result?.results && frame.result?.lab && t?.action === "oldfiles.scan") {
    storeOldfileScan(frame.result);
  }
  if (frame.logs) {
    db()
      .prepare(
        `INSERT INTO logs (ts, level, source, task_id, msg, detail)
         VALUES (?, ?, 'task', ?, ?, ?)`,
      )
      .run(Date.now(), frame.ok ? "INFO" : "ERROR", frame.id, `task ${frame.ok ? "ok" : "failed"}`, frame.logs);
  }
}

function handleLog(node: string, frame: any): void {
  db()
    .prepare(
      `INSERT INTO logs (ts, node, level, source, lab, user, task_id, msg, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      frame.ts ?? Date.now(),
      node,
      frame.level ?? "INFO",
      boundedStr(frame.source, 32),
      boundedStr(frame.lab, 40),
      boundedStr(frame.user, 32),
      boundedStr(frame.task_id, 64),
      clampText(frame.msg, 2000) ?? "",
      clampText(frame.detail, 8000),
    );
  maybeAlertOnLog({
    node,
    level: frame.level ?? "INFO",
    source: frame.source,
    msg: frame.msg ?? "",
    detail: frame.detail,
  });
}

const GPU_STATES = new Set(["idle", "warned", "killed"]);
// Per (node,user,state) outbound-mail throttle so a spamming node can't flood a student (M-01).
const gpuMailState = new Map<string, number>();
const GPU_MAIL_WINDOW_MS = 10 * 60 * 1000;

/** Coerce an unknown field to a bounded string (control chars stripped) or null. */
function boundedStr(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  const clean = Array.from(v).filter((c) => c >= " " && c !== "\x7f").join("").slice(0, max);
  return clean.length ? clean : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** Length-clamp a free-text field (msg/detail), preserving newlines/tabs; null if not a string. */
function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return v.slice(0, max);
}

function handleEvent(node: string, frame: any): void {
  if (frame.kind !== "gpu") return;
  const raw = frame.payload ?? {};
  // Validate the payload before it touches the DB or an email (M-01).
  const p = {
    pid: intOrNull(raw.pid),
    user: boundedStr(raw.user, 32),
    lab: boundedStr(raw.lab, 40),
    vram_bytes: intOrNull(raw.vram_bytes),
    state: GPU_STATES.has(raw.state) ? (raw.state as string) : "idle",
  };
  db()
    .prepare(
      `INSERT INTO gpu_events (node, pid, user, lab, vram_bytes, state, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(node, p.pid, p.user, p.lab, p.vram_bytes, p.state, intOrNull(frame.ts) ?? Date.now());
  void emailGpuEvent(node, p);
}

async function emailGpuEvent(
  node: string,
  p: { user: string | null; lab: string | null; pid: number | null; state: string },
): Promise<void> {
  if (!p.user || (p.state !== "warned" && p.state !== "killed")) return;
  // Only email a student the sending node actually hosts — a node can't target arbitrary students.
  const owns = db()
    .prepare(
      `SELECT 1 FROM students
         JOIN lab_members ON lab_members.student_id = students.id
         JOIN labs ON labs.id = lab_members.lab_id
         JOIN nodes ON nodes.id = labs.node_id
        WHERE students.username = ? AND nodes.name = ? LIMIT 1`,
    )
    .get(p.user, node);
  if (!owns) return;
  const row = db().prepare("SELECT email FROM students WHERE username = ?").get(p.user) as
    | { email: string | null }
    | undefined;
  if (!row?.email) return;
  // Throttle repeated mail for the same (node,user,state).
  const key = `${node}:${p.user}:${p.state}`;
  const now = Date.now();
  const last = gpuMailState.get(key) ?? 0;
  if (now - last < GPU_MAIL_WINDOW_MS) return;
  gpuMailState.set(key, now);

  const { sendGpuKillEmail, sendGpuWarningEmail } = await import("./mailer");
  if (p.state === "warned") {
    await sendGpuWarningEmail(row.email, {
      lab: p.lab,
      pid: p.pid,
      graceMinutes: getSetting("gpuGraceMinutes"),
    });
  } else {
    await sendGpuKillEmail(row.email, { lab: p.lab, pid: p.pid });
  }
}

function handleTelemetry(node: string, frame: any): void {
  ingestTelemetry(node, frame.payload ?? {});
}

// ----------------------------------------------------------------- node registry

function registerNode(node: string, capabilities: unknown): void {
  // The node is back: drop any in-flight offline alert before it fires.
  cancelOfflineAlert(node);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO nodes (name, last_seen, online, capabilities, created_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, online = 1, capabilities = excluded.capabilities`,
    )
    .run(node, now, JSON.stringify(capabilities), now);
}

function deregisterNode(node: string): void {
  const conn = connections.get(node);
  if (conn) {
    clearInterval(conn.consumer);
    connections.delete(node);
  }
  db().prepare(`UPDATE nodes SET online = 0, last_seen = ? WHERE name = ?`).run(Date.now(), node);

  // Don't page admins on a momentary drop. Wait out the grace window; if the node hasn't reconnected
  // (and isn't claimed by a fresh socket) by then, alert. A reconnect cancels the timer in
  // registerNode. A second disconnect just reschedules (clear the old timer first).
  cancelOfflineAlert(node);
  const graceMs = Math.max(0, getSetting("nodeOfflineGraceSeconds")) * 1000;
  const fire = () => {
    pendingOfflineAlerts.delete(node);
    if (connections.has(node)) return; // reconnected
    const row = db().prepare("SELECT online, alias FROM nodes WHERE name = ?").get(node) as
      | { online: number; alias: string | null }
      | undefined;
    if (!row || row.online === 1) return; // gone or back online
    alertNodeOffline(node, row.alias ?? undefined);
  };
  if (graceMs === 0) {
    fire();
  } else {
    pendingOfflineAlerts.set(node, setTimeout(fire, graceMs));
  }
}

/** Wire the hub to the HTTP server's upgrade event for a given path. */
export function attachHub(server: import("node:http").Server, path = "/agent"): WebSocketServer {
  const wss = createHub();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { url } = req;
    if (!url || new URL(url, "http://localhost").pathname !== path) {
      return; // let Next/HMR handle other upgrade paths
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return wss;
}

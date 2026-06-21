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
import { verifyNodeAuth } from "./nodes";
import { ackTask, claimTask, markTaskState, retryTask } from "./queue";
import { getSetting } from "./settings";

interface NodeConn {
  ws: WebSocket;
  node: string;
  consumer: NodeJS.Timeout;
}

const connections = new Map<string, NodeConn>();
const WORKER_PREFIX = "controller-hub";

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

export function createHub(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    let node: string | null = null;

    ws.on("message", (raw) => {
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
  if (!frame.ok) {
    const t = db().prepare("SELECT node, action FROM task_log WHERE task_uuid = ?").get(frame.id) as
      | { node: string; action: string }
      | undefined;
    if (t) alertTaskFailed(t.node, t.action, frame.error ?? "unknown error");
  }
  // Persist scan results into the oldfile_scans table.
  if (frame.ok && frame.result?.results && frame.result?.lab) {
    const row = db().prepare("SELECT action FROM task_log WHERE task_uuid = ?").get(frame.id) as
      | { action: string }
      | undefined;
    if (row?.action === "oldfiles.scan") storeOldfileScan(frame.result);
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
      frame.source ?? null,
      frame.lab ?? null,
      frame.user ?? null,
      frame.task_id ?? null,
      frame.msg ?? "",
      frame.detail ?? null,
    );
  maybeAlertOnLog({
    node,
    level: frame.level ?? "INFO",
    source: frame.source,
    msg: frame.msg ?? "",
    detail: frame.detail,
  });
}

function handleEvent(node: string, frame: any): void {
  const p = frame.payload ?? {};
  if (frame.kind === "gpu") {
    db()
      .prepare(
        `INSERT INTO gpu_events (node, pid, user, lab, vram_bytes, state, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(node, p.pid ?? null, p.user ?? null, p.lab ?? null, p.vram_bytes ?? null, p.state ?? "idle", frame.ts ?? Date.now());
    void emailGpuEvent(p);
  }
}

async function emailGpuEvent(p: any): Promise<void> {
  if (!p.user || (p.state !== "warned" && p.state !== "killed")) return;
  const row = db().prepare("SELECT email FROM students WHERE username = ?").get(p.user) as
    | { email: string | null }
    | undefined;
  if (!row?.email) return;
  const { sendGpuKillEmail, sendGpuWarningEmail } = await import("./mailer");
  if (p.state === "warned") {
    await sendGpuWarningEmail(row.email, {
      lab: p.lab ?? null,
      pid: p.pid,
      graceMinutes: getSetting("gpuGraceMinutes"),
    });
  } else {
    await sendGpuKillEmail(row.email, { lab: p.lab ?? null, pid: p.pid });
  }
}

function handleTelemetry(node: string, frame: any): void {
  ingestTelemetry(node, frame.payload ?? {});
}

// ----------------------------------------------------------------- node registry

function registerNode(node: string, capabilities: unknown): void {
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
  alertNodeOffline(node);
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

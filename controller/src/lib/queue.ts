/**
 * Durable task queue backed by honker. One honker queue per node ("node:<name>") so the hub can
 * claim work destined for a specific agent. Tasks are also mirrored into the `task_log` table so the
 * UI can show their lifecycle (queued -> sent -> ok/failed).
 *
 * honker gets its own SQLite file (queue.db) next to the authoritative controller.db, so the native
 * honker engine and better-sqlite3 never contend over the same file.
 */

import honker from "@russellthehippo/honker-node";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "./db";
import { env } from "./env";
import { decryptSecret, encryptSecret } from "./secrets";

export interface TaskFrame {
  type: "task";
  id: string;
  action: string;
  params: Record<string, unknown>;
  requested_by?: string;
  ts: number;
}

// Keys whose values are credentials and must never be persisted in the long-lived task_log (which is
// backed up) or shown in the UI. Matched case-insensitively as a substring of the key.
const SECRET_KEY_RE = /pass|token|secret|key/i;
const REDACTED = "••••••";

/** Deep-copy a value, masking the values of any credential-looking keys. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** Decode a honker job payload, decrypting the at-rest envelope (legacy plaintext passes through). */
function decodeFrame(payload: unknown): TaskFrame {
  if (payload && typeof payload === "object" && typeof (payload as any)._enc === "string") {
    return JSON.parse(decryptSecret((payload as any)._enc)) as TaskFrame;
  }
  return payload as TaskFrame;
}

let _hk: any = null;

function hk(): any {
  if (_hk) return _hk;
  const queuePath = join(dirname(env.dbPath), "queue.db");
  mkdirSync(dirname(queuePath), { recursive: true });
  _hk = honker.open(queuePath);
  return _hk;
}

function nodeQueue(node: string): any {
  return hk().queue(`node:${node}`);
}

/** Enqueue a task for a node. Returns the task id (also stored in task_log). */
export function enqueueTask(
  node: string,
  action: string,
  params: Record<string, unknown> = {},
  requestedBy?: string,
): TaskFrame {
  const frame: TaskFrame = {
    type: "task",
    id: randomUUID(),
    action,
    params,
    requested_by: requestedBy,
    ts: Date.now(),
  };
  // The queue payload carries the FULL params (incl. any password) the agent needs to execute, but
  // it is encrypted at rest (queue.db is never backed up). The persistent, backed-up task_log stores
  // a REDACTED copy — credentials never land in long-lived storage or the UI.
  const jobId = nodeQueue(node).enqueue({ _enc: encryptSecret(JSON.stringify(frame)) });
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO task_log (task_uuid, job_id, node, action, params, requested_by, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(frame.id, jobId, node, action, JSON.stringify(redactSecrets(params)), requestedBy ?? null, now, now);
  // Wake any consumer waiting on this node's channel.
  try {
    hk().notify(`node:${node}`);
  } catch {
    /* notify is best-effort */
  }
  return frame;
}

export interface TaskRow {
  task_uuid: string;
  job_id: number | null;
  node: string;
  action: string;
  params: string | null;
  requested_by: string | null;
  state: string;
  result: string | null;
  error: string | null;
  received_at: number | null;
  attempts: number;
  result_cached: number;
  created_at: number;
  updated_at: number;
}

/** Fetch a single task's full record by its UUID, or null if unknown. */
export function getTask(taskUuid: string): TaskRow | null {
  const row = db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(taskUuid) as
    | TaskRow
    | undefined;
  return row ?? null;
}

/** Claim the next pending task for a node, or null if the queue is empty. */
export function claimTask(node: string, workerId: string): { jobId: number; frame: TaskFrame } | null {
  const job = nodeQueue(node).claimOne(workerId);
  if (!job) return null;
  return { jobId: job.id, frame: decodeFrame(job.payload) };
}

export function ackTask(node: string, jobId: number, workerId: string): void {
  // honker_ack only releases the job for the worker that claimed it, so the worker id is required.
  nodeQueue(node).ackBatch([jobId], workerId);
}

export function retryTask(node: string, jobId: number, workerId: string, error: string): void {
  // honker exposes per-job retry; signature is _retry(jobId, workerId, delaySeconds, error).
  try {
    nodeQueue(node)._retry(jobId, workerId, 5, error);
  } catch {
    /* if the job already expired it will be redelivered anyway */
  }
}

/**
 * Update a task's lifecycle state, bound to the node the task was queued for. Returns true if a row
 * matched. The `node` binding means a compromised/spoofing agent cannot complete, fail, or poison a
 * task that belongs to a different node (H-03) — a foreign UUID simply matches nothing. `cached`
 * records that the agent replayed a previously-computed result for a redelivered task (idempotent).
 */
export function markTaskState(
  node: string,
  taskUuid: string,
  state: string,
  result?: unknown,
  error?: string,
  cached?: boolean,
): boolean {
  const info = db()
    .prepare(
      `UPDATE task_log SET state = ?, result = ?, error = ?, result_cached = ?, updated_at = ?
       WHERE task_uuid = ? AND node = ? AND state NOT IN ('ok', 'failed')`,
    )
    .run(
      state,
      result === undefined ? null : JSON.stringify(result),
      error ?? null,
      cached ? 1 : 0,
      Date.now(),
      taskUuid,
      node,
    );
  return info.changes > 0;
}

/**
 * Record the agent's durable receipt of a pushed task (it persisted it to its local queue). Sets
 * received_at once; node-bound like markTaskState so a foreign UUID matches nothing.
 */
export function markTaskReceived(node: string, taskUuid: string): void {
  db()
    .prepare(
      "UPDATE task_log SET received_at = ? WHERE task_uuid = ? AND node = ? AND received_at IS NULL",
    )
    .run(Date.now(), taskUuid, node);
}

/** Count a (re)send of a task toward its attempt total (drives the UI's redelivery visibility). */
export function bumpAttempts(node: string, taskUuid: string): void {
  db()
    .prepare("UPDATE task_log SET attempts = attempts + 1 WHERE task_uuid = ? AND node = ?")
    .run(taskUuid, node);
}

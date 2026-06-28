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

export interface TaskFrame {
  type: "task";
  id: string;
  action: string;
  params: Record<string, unknown>;
  requested_by?: string;
  ts: number;
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
  const jobId = nodeQueue(node).enqueue(frame);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO task_log (task_uuid, job_id, node, action, params, requested_by, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(frame.id, jobId, node, action, JSON.stringify(params), requestedBy ?? null, now, now);
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
  return { jobId: job.id, frame: job.payload as TaskFrame };
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
 * task that belongs to a different node (H-03) — a foreign UUID simply matches nothing.
 */
export function markTaskState(
  node: string,
  taskUuid: string,
  state: string,
  result?: unknown,
  error?: string,
): boolean {
  const info = db()
    .prepare(
      `UPDATE task_log SET state = ?, result = ?, error = ?, updated_at = ?
       WHERE task_uuid = ? AND node = ?`,
    )
    .run(state, result === undefined ? null : JSON.stringify(result), error ?? null, Date.now(), taskUuid, node);
  return info.changes > 0;
}

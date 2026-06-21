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

export function markTaskState(taskUuid: string, state: string, result?: unknown, error?: string): void {
  db()
    .prepare(
      `UPDATE task_log SET state = ?, result = ?, error = ?, updated_at = ? WHERE task_uuid = ?`,
    )
    .run(state, result === undefined ? null : JSON.stringify(result), error ?? null, Date.now(), taskUuid);
}

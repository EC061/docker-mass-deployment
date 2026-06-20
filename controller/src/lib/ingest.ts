/**
 * Ingestion of agent telemetry + scan results into the controller DB.
 *
 * Dataset names encode the lab/student, so we parse them back:
 *   <pool>/labs/<lab>                 -> lab-level usage
 *   <pool>/labs/<lab>/users/<user>    -> student-level usage
 * (the `shared` and intermediate `users` datasets are ignored for sampling).
 */

import { db } from "./db";

const STORAGE_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;

interface ParsedDataset {
  lab: string;
  user: string | null;
  level: "lab" | "user" | "other";
}

function parseDataset(dataset: string): ParsedDataset | null {
  const idx = dataset.indexOf("/labs/");
  if (idx === -1) return null;
  const rest = dataset.slice(idx + "/labs/".length).split("/");
  const lab = rest[0];
  if (!lab) return null;
  if (rest.length === 1) return { lab, user: null, level: "lab" };
  if (rest.length === 3 && rest[1] === "users") return { lab, user: rest[2], level: "user" };
  return { lab, user: null, level: "other" };
}

function labIdByName(name: string): number | null {
  const row = db().prepare("SELECT id FROM labs WHERE name = ?").get(name) as { id: number } | undefined;
  return row?.id ?? null;
}

function studentIdInLab(labId: number, username: string): number | null {
  const row = db()
    .prepare(
      `SELECT students.id AS id FROM lab_members
       JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? AND students.username = ?`,
    )
    .get(labId, username) as { id: number } | undefined;
  return row?.id ?? null;
}

function shouldSample(labId: number, studentId: number | null, pool: string, now: number): boolean {
  const row = db()
    .prepare(
      `SELECT ts FROM storage_samples
       WHERE lab_id = ? AND ifnull(student_id, -1) = ifnull(?, -1) AND pool = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(labId, studentId, pool) as { ts: number } | undefined;
  return !row || now - row.ts >= STORAGE_SAMPLE_MIN_INTERVAL_MS;
}

interface DatasetUsage {
  pool: string;
  dataset: string;
  used_bytes: number;
  quota_bytes: number | null;
}

export function ingestTelemetry(node: string, payload: any): void {
  const now = Date.now();

  // Latest pool free space + liveness.
  db()
    .prepare("UPDATE nodes SET pools = ?, last_seen = ? WHERE name = ?")
    .run(JSON.stringify(payload.pools ?? []), now, node);

  // Per-dataset storage samples (throttled).
  const insertSample = db().prepare(
    `INSERT INTO storage_samples (lab_id, student_id, pool, used_bytes, quota_bytes, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const ds of (payload.datasets ?? []) as DatasetUsage[]) {
    const parsed = parseDataset(ds.dataset);
    if (!parsed || parsed.level === "other") continue;
    const labId = labIdByName(parsed.lab);
    if (labId === null) continue;
    const studentId = parsed.user ? studentIdInLab(labId, parsed.user) : null;
    if (parsed.level === "user" && studentId === null) continue;
    if (!shouldSample(labId, studentId, ds.pool, now)) continue;
    insertSample.run(labId, studentId, ds.pool, ds.used_bytes, ds.quota_bytes ?? null, now);
  }

  // GPU snapshot: replace this node's rows with the current process list.
  const gpu = (payload.gpu_processes ?? []) as any[];
  const tx = db().transaction(() => {
    db().prepare("DELETE FROM gpu_snapshot WHERE node = ?").run(node);
    const ins = db().prepare(
      `INSERT OR REPLACE INTO gpu_snapshot (node, pid, user, lab, vram_bytes, util, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of gpu) {
      ins.run(node, p.pid, p.user ?? null, p.lab ?? null, p.vram_bytes ?? null, p.util ?? null, now);
    }
  });
  tx();
}

export function storeOldfileScan(result: any): void {
  const lab = result?.lab;
  if (!lab) return;
  const labId = labIdByName(lab);
  if (labId === null) return;
  const now = Date.now();
  // Replace prior scans for this lab so the UI shows the latest.
  db().prepare("DELETE FROM oldfile_scans WHERE lab_id = ?").run(labId);
  const ins = db().prepare(
    `INSERT INTO oldfile_scans
       (lab_id, student_id, atime_count, atime_bytes, mtime_count, mtime_bytes, oldest, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of (result.results ?? []) as any[]) {
    const studentId = row.username ? studentIdInLab(labId, row.username) : null;
    ins.run(
      labId,
      studentId,
      row.atime_count ?? 0,
      row.atime_bytes ?? 0,
      row.mtime_count ?? 0,
      row.mtime_bytes ?? 0,
      row.oldest ?? null,
      now,
    );
  }
}

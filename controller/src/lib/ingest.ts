/**
 * Ingestion of agent telemetry + scan results into the controller DB.
 *
 * Dataset names encode the lab/student, so we parse them back:
 *   <pool>/labs/<lab>                 -> lab-level usage
 *   <pool>/labs/<lab>/users/<user>    -> student-level usage
 * (the `shared` and intermediate `users` datasets are ignored for sampling).
 */

import { db } from "./db";
import { fmtBytes } from "./format";
import { sendQuotaEmail } from "./mailer";
import { getSetting } from "./settings";

const STORAGE_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_ALERT_DEDUP_MS = 6 * 60 * 60 * 1000; // re-alert a PI about the same pool at most every 6h

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
    if (parsed.level === "lab" && ds.quota_bytes) {
      maybeQuotaAlert(labId, ds.pool, ds.used_bytes, ds.quota_bytes, now);
    }
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

function maybeQuotaAlert(labId: number, pool: string, used: number, quota: number, now: number): void {
  const pct = Math.round((used / quota) * 100);
  if (pct < getSetting("quotaAlertPct")) return;

  const recent = db()
    .prepare("SELECT ts FROM quota_alerts WHERE lab_id = ? AND pool = ? ORDER BY ts DESC LIMIT 1")
    .get(labId, pool) as { ts: number } | undefined;
  if (recent && now - recent.ts < QUOTA_ALERT_DEDUP_MS) return;

  const lab = db().prepare("SELECT name, pi_email FROM labs WHERE id = ?").get(labId) as
    | { name: string; pi_email: string | null }
    | undefined;
  if (!lab) return;

  db().prepare("INSERT INTO quota_alerts (lab_id, pool, pct, ts) VALUES (?, ?, ?, ?)").run(labId, pool, pct, now);
  if (!lab.pi_email) return;

  // Latest per-student usage on this pool for the breakdown.
  const breakdown = (db()
    .prepare(
      `SELECT students.username AS username, s.used_bytes AS used
       FROM storage_samples s JOIN students ON students.id = s.student_id
       WHERE s.lab_id = ? AND s.pool = ? AND s.student_id IS NOT NULL
         AND s.ts = (SELECT MAX(ts) FROM storage_samples s2 WHERE s2.student_id = s.student_id AND s2.pool = s.pool)
       GROUP BY students.id ORDER BY used DESC`,
    )
    .all(labId, pool) as { username: string; used: number }[]).map((b) => ({
    username: b.username,
    usedHuman: fmtBytes(b.used),
  }));

  void sendQuotaEmail({
    to: lab.pi_email,
    lab: lab.name,
    pool,
    pct,
    usedHuman: fmtBytes(used),
    quotaHuman: fmtBytes(quota),
    breakdown,
  });
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

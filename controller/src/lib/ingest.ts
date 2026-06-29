/**
 * Ingestion of agent telemetry + scan results into the controller DB.
 *
 * Dataset names encode the lab/student, so we parse them back:
 *   <pool>/labs/<lab>                 -> lab-level usage
 *   <pool>/labs/<lab>/users/<user>    -> student-level usage
 * (the `shared` and intermediate `users` datasets are ignored for sampling).
 */

import { alertAdmins } from "./alerts";
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

/**
 * Whether to persist a new sample for (lab, student, pool).
 *
 * Lab-level fast/slow ZFS rows — recomputed by the agent on its lab-usage cadence (~5 min) and
 * re-reported on each heartbeat — are throttled to one row per STORAGE_SAMPLE_MIN_INTERVAL_MS so the
 * time-series stays bounded. Scan-derived metrics (`scanDerived`) — the docker writable layer and
 * the per-student `du` breakdown — only change when a usage scan runs, so they bypass the throttle
 * whenever the value actually changes. Without that bypass, a fresh on-demand "Scan now" landing on
 * a heartbeat <5min after the previous sample would be silently dropped, leaving the table stuck on
 * the pre-scan number even though "updated Xm ago" (usage_scanned_at, which always moves forward)
 * advanced — the exact desync where the image total froze at a stale value after delete+scan until a
 * manual reload. Storing only on *change* keeps the series from bloating between scans (the agent
 * re-reports the same cached number every heartbeat), so this fires at most once per scan.
 */
function shouldSample(
  labId: number,
  studentId: number | null,
  pool: string,
  used: number,
  now: number,
  scanDerived: boolean,
): boolean {
  // Order by id (insertion order), not ts: two samples can share a millisecond, and a ts tie would
  // make "the latest value" ambiguous — picking an older-value row would spuriously store a change.
  const row = db()
    .prepare(
      `SELECT ts, used_bytes AS used FROM storage_samples
       WHERE lab_id = ? AND ifnull(student_id, -1) = ifnull(?, -1) AND pool = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(labId, studentId, pool) as { ts: number; used: number } | undefined;
  if (!row) return true;
  if (now - row.ts >= STORAGE_SAMPLE_MIN_INTERVAL_MS) return true;
  return scanDerived && row.used !== used;
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

  // ZFS scrub status: store the latest, alert admins when a pool newly reports errors.
  ingestScrub(node, payload.scrub, now);

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
    // The docker writable layer (lab-level image + per-student homes) and per-student fast/slow rows
    // change only when their cache is recomputed — the lab-usage refresh or the `du` scan — so
    // they're scan-derived: store on change to let a fresh value land immediately. Lab-level
    // fast/slow are periodic ZFS reads, re-reported every heartbeat — keep them throttled.
    const scanDerived = ds.pool === "docker" || parsed.level === "user";
    if (!shouldSample(labId, studentId, ds.pool, ds.used_bytes, now, scanDerived)) continue;
    insertSample.run(labId, studentId, ds.pool, ds.used_bytes, ds.quota_bytes ?? null, now);
    // The "docker" pool is the container writable layer (installed software), tracked for the
    // labquota breakdown but not a managed quota — never raise a PI quota alert on it.
    if (parsed.level === "lab" && ds.quota_bytes && ds.pool !== "docker") {
      maybeQuotaAlert(labId, ds.pool, ds.used_bytes, ds.quota_bytes, now);
    }
  }

  // Per-lab usage-scan freshness: when the agent last ran the per-student du breakdown. Only ever
  // moves forward, so a stale heartbeat (or one from before a scan) can't roll it back.
  for (const u of (payload.usage_scans ?? []) as { lab?: string; scanned_at?: number | null }[]) {
    if (!u.lab || typeof u.scanned_at !== "number") continue;
    const labId = labIdByName(u.lab);
    if (labId === null) continue;
    db()
      .prepare(
        "UPDATE labs SET usage_scanned_at = ? WHERE id = ? AND (usage_scanned_at IS NULL OR usage_scanned_at < ?)",
      )
      .run(u.scanned_at, labId, u.scanned_at);
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

interface ScrubEntry {
  pool: string;
  state?: string;
  healthy?: boolean;
  scrubbing?: boolean;
  errors?: number;
  last_scrub?: string | null;
  detail?: string;
}

function isBadScrub(p: ScrubEntry): boolean {
  return p.healthy === false || (typeof p.errors === "number" && p.errors !== 0);
}

/** Persist the latest scrub status; log + alert when a pool transitions into an error state. */
function ingestScrub(node: string, scrub: unknown, now: number): void {
  if (!Array.isArray(scrub)) return;
  const entries = scrub as ScrubEntry[];

  const prevRow = db().prepare("SELECT scrub_status FROM nodes WHERE name = ?").get(node) as
    | { scrub_status: string | null }
    | undefined;
  let prev: ScrubEntry[] = [];
  try {
    prev = prevRow?.scrub_status ? (JSON.parse(prevRow.scrub_status) as ScrubEntry[]) : [];
  } catch {
    prev = [];
  }
  const prevBad = new Set(prev.filter(isBadScrub).map((p) => p.pool));

  db().prepare("UPDATE nodes SET scrub_status = ? WHERE name = ?").run(JSON.stringify(entries), node);

  for (const p of entries) {
    if (!isBadScrub(p) || prevBad.has(p.pool)) continue;
    // Newly unhealthy -> one ERROR log (shows on the Logs page) + a deduped admin alert.
    const msg = `ZFS scrub on ${node}: pool '${p.pool}' reports errors`;
    const detail =
      p.detail ?? `state=${p.state ?? "?"}; errors=${p.errors ?? "?"}; scan=${p.last_scrub ?? "n/a"}`;
    db()
      .prepare(
        `INSERT INTO logs (ts, node, level, source, msg, detail) VALUES (?, ?, 'ERROR', 'scrub', ?, ?)`,
      )
      .run(now, node, msg, detail);
    void alertAdmins(`scrub:${node}:${p.pool}`, `ZFS scrub errors on ${node}`, `${msg}\n\n${detail}`);
  }
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

/**
 * Ingestion of agent telemetry + scan results into the controller DB.
 *
 * A telemetry frame arrives from a specific authenticated `node`. Dataset names encode the lab and
 * (optionally) the student, so we parse them back and resolve them to the PLACEMENT (lab on that
 * node) — a lab can run on several nodes, so usage is always bound to (lab, node):
 *   <pool>/labs/<lab>                 -> placement-level usage
 *   <pool>/labs/<lab>/users/<user>    -> per-student usage
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

interface PlacementRef {
  placement_id: number;
  lab_id: number;
}

/** Resolve a (lab name, node name) to its placement, or null when this node doesn't host that lab. */
function placementByLabNode(labName: string, node: string): PlacementRef | null {
  const row = db()
    .prepare(
      `SELECT p.id AS placement_id, p.lab_id AS lab_id
       FROM lab_placements p
       JOIN labs ON labs.id = p.lab_id
       JOIN nodes ON nodes.id = p.node_id
       WHERE labs.name = ? AND nodes.name = ?`,
    )
    .get(labName, node) as PlacementRef | undefined;
  return row ?? null;
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
 * Whether to persist a new sample for (placement, student, pool). Lab/placement-level fast/slow ZFS
 * rows are periodic reads re-reported every heartbeat — throttled to one row per interval to bound
 * the series. Scan-derived metrics (docker writable layer + per-student `du`) change only when a scan
 * runs, so they bypass the throttle whenever the value actually changes (store-on-change).
 */
function shouldSample(
  placementId: number,
  studentId: number | null,
  pool: string,
  used: number,
  now: number,
  scanDerived: boolean,
): boolean {
  const row = db()
    .prepare(
      `SELECT ts, used_bytes AS used FROM storage_samples
       WHERE placement_id = ? AND ifnull(student_id, -1) = ifnull(?, -1) AND pool = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(placementId, studentId, pool) as { ts: number; used: number } | undefined;
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

  // Per-dataset storage samples (throttled), bound to this node's placement for the lab.
  const insertSample = db().prepare(
    `INSERT INTO storage_samples (placement_id, lab_id, student_id, pool, used_bytes, quota_bytes, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ds of (payload.datasets ?? []) as DatasetUsage[]) {
    const parsed = parseDataset(ds.dataset);
    if (!parsed || parsed.level === "other") continue;
    const ref = placementByLabNode(parsed.lab, node);
    if (!ref) continue; // node isn't hosting this lab per our records — reject foreign telemetry
    const studentId = parsed.user ? studentIdInLab(ref.lab_id, parsed.user) : null;
    if (parsed.level === "user" && studentId === null) continue;
    const scanDerived = ds.pool === "docker" || parsed.level === "user";
    if (!shouldSample(ref.placement_id, studentId, ds.pool, ds.used_bytes, now, scanDerived)) continue;
    insertSample.run(ref.placement_id, ref.lab_id, studentId, ds.pool, ds.used_bytes, ds.quota_bytes ?? null, now);
    // The "docker" pool is the container writable layer (installed software), tracked for the
    // labquota breakdown but not a managed quota — never raise a PI quota alert on it.
    if (parsed.level === "lab" && ds.quota_bytes && ds.pool !== "docker") {
      maybeQuotaAlert(ref.placement_id, ref.lab_id, ds.pool, ds.used_bytes, ds.quota_bytes, now);
    }
  }

  // Per-placement usage-scan freshness (only ever moves forward).
  for (const u of (payload.usage_scans ?? []) as { lab?: string; scanned_at?: number | null }[]) {
    if (!u.lab || typeof u.scanned_at !== "number") continue;
    const ref = placementByLabNode(u.lab, node);
    if (!ref) continue;
    db()
      .prepare(
        "UPDATE lab_placements SET usage_scanned_at = ? WHERE id = ? AND (usage_scanned_at IS NULL OR usage_scanned_at < ?)",
      )
      .run(u.scanned_at, ref.placement_id, u.scanned_at);
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

function maybeQuotaAlert(
  placementId: number,
  labId: number,
  pool: string,
  used: number,
  quota: number,
  now: number,
): void {
  const pct = Math.round((used / quota) * 100);
  if (pct < getSetting("quotaAlertPct")) return;

  const recent = db()
    .prepare("SELECT ts FROM quota_alerts WHERE placement_id = ? AND pool = ? ORDER BY ts DESC LIMIT 1")
    .get(placementId, pool) as { ts: number } | undefined;
  if (recent && now - recent.ts < QUOTA_ALERT_DEDUP_MS) return;

  const lab = db().prepare("SELECT name, pi_email FROM labs WHERE id = ?").get(labId) as
    | { name: string; pi_email: string | null }
    | undefined;
  if (!lab) return;

  db()
    .prepare("INSERT INTO quota_alerts (placement_id, lab_id, pool, pct, ts) VALUES (?, ?, ?, ?, ?)")
    .run(placementId, labId, pool, pct, now);
  if (!lab.pi_email) return;

  // Latest per-student usage on this placement+pool for the breakdown.
  const breakdown = (db()
    .prepare(
      `SELECT students.username AS username, s.used_bytes AS used
       FROM storage_samples s JOIN students ON students.id = s.student_id
       WHERE s.placement_id = ? AND s.pool = ? AND s.student_id IS NOT NULL
         AND s.ts = (SELECT MAX(ts) FROM storage_samples s2 WHERE s2.student_id = s.student_id AND s2.placement_id = s.placement_id AND s2.pool = s.pool)
       GROUP BY students.id ORDER BY used DESC`,
    )
    .all(placementId, pool) as { username: string; used: number }[]).map((b) => ({
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

/**
 * Storage stats, grouped node -> lab -> student, for the Stats page. The page presents two
 * separately-cadenced kinds of data, both read from the latest `storage_samples` row per (lab,
 * student, pool):
 *
 *   - LIVE container-level (`LabStats.live`): the whole-container writable layer ("whole image",
 *     pool=docker, student_id NULL) plus the live lab-level fast/slow ZFS usage-vs-quota. These are
 *     re-measured on every agent heartbeat, so they are always current.
 *   - NIGHTLY per-student (`LabStats.students`): each student's docker home (installed software),
 *     scratch (fast) and cold (slow) `du`. These come from the per-student usage scan (nightly +
 *     on-demand "Scan now"), so they carry a freshness timestamp.
 */

import { db } from "./db";
import { listLabs } from "./labs";
import { listMembers } from "./students";

export interface StudentUsage {
  studentId: number;
  username: string;
  name: string | null;
  docker: number | null; // docker home (installed software) attributed to this student
  fast: number | null; // scratch
  slow: number | null; // cold storage
}

export interface LabStats {
  labId: number;
  labName: string;
  image: string;
  students: StudentUsage[];
  // Container + lab totals, refreshed every heartbeat (see module doc).
  live: {
    image: number | null; // whole-container writable layer (SizeRw) for the lab container
    fast: { used: number | null; quota: number | null };
    slow: { used: number | null; quota: number | null };
  };
  usageScannedAt: number | null; // when the per-student du breakdown was last computed
  scanStale: boolean; // no scan yet, or older than USAGE_STALE_MS -> offer a "Scan now" button
  scanPending: boolean; // a usage.scan task is queued/sent for this lab and not yet done
}

// A per-student usage scan older than this warrants offering a manual rescan. Matches the agent's
// default unprompted docker-scan cadence (docker_scan_interval_s = 1h).
const USAGE_STALE_MS = 60 * 60 * 1000;

export interface NodeStats {
  node: string;
  online: number;
  labs: LabStats[];
  totalImageBytes: number; // sum of each lab's whole-image writable layer on this node
}

interface Cell {
  used: number;
  quota: number | null;
}

/** Latest sample per (lab, student|lab-level, pool), indexed for O(1) lookup while building. */
function latestSamples(): Map<string, Cell> {
  const rows = db()
    .prepare(
      `SELECT s.lab_id AS lab_id, s.student_id AS student_id, s.pool AS pool,
              s.used_bytes AS used, s.quota_bytes AS quota
       FROM storage_samples s
       WHERE s.ts = (SELECT MAX(ts) FROM storage_samples s2
                     WHERE s2.lab_id = s.lab_id AND s2.pool = s.pool
                       AND ((s2.student_id IS NULL AND s.student_id IS NULL)
                            OR s2.student_id = s.student_id))`,
    )
    .all() as { lab_id: number; student_id: number | null; pool: string; used: number; quota: number | null }[];
  const map = new Map<string, Cell>();
  for (const r of rows) {
    map.set(`${r.lab_id}:${r.student_id ?? "L"}:${r.pool}`, { used: r.used, quota: r.quota });
  }
  return map;
}

// After a usage.scan task is marked done we keep treating the lab as "scanning" until the fresh
// per-student numbers actually land. The agent runs the scan synchronously and marks the task `ok`
// the instant it returns, but the new du breakdown (and usage_scanned_at) only reach us on the
// *next* heartbeat — so without this grace the "Scan now" button would pop back while the table is
// still showing the pre-scan numbers. Bounded so a heartbeat that never arrives can't hide the
// button forever.
const SCAN_INGEST_GRACE_MS = 10 * 60 * 1000;

/**
 * Most-recent usage.scan task per `${node}::${labName}` — its state and when it was requested. We
 * keep only the latest so a stale ok/failed task never masks a newer in-flight one; `scanPending`
 * (computed per lab in buildStats, where the scan-freshness timestamp is known) reads off this.
 */
function latestUsageScans(): Map<string, { state: string; createdAt: number }> {
  const rows = db()
    .prepare(
      "SELECT node, params, state, created_at AS createdAt FROM task_log WHERE action = 'usage.scan' ORDER BY created_at ASC",
    )
    .all() as { node: string; params: string | null; state: string; createdAt: number }[];
  const map = new Map<string, { state: string; createdAt: number }>();
  for (const r of rows) {
    try {
      const lab = (JSON.parse(r.params ?? "{}") as { lab?: string }).lab;
      if (lab) map.set(`${r.node}::${lab}`, { state: r.state, createdAt: r.createdAt });
    } catch {
      /* ignore malformed params */
    }
  }
  return map;
}

/** Whether a lab should still read as "scanning" given its latest scan task and data freshness. */
function isScanPending(
  scan: { state: string; createdAt: number } | undefined,
  usageScannedAt: number | null,
  now: number,
): boolean {
  if (!scan) return false;
  // Dispatched and not yet acknowledged done.
  if (scan.state === "queued" || scan.state === "sent") return true;
  // Done on the agent, but keep "scanning" until the post-scan heartbeat advances usage_scanned_at
  // past when we requested it (i.e. the new numbers have been ingested).
  if (scan.state === "ok") {
    return (
      (usageScannedAt === null || usageScannedAt < scan.createdAt) &&
      now - scan.createdAt < SCAN_INGEST_GRACE_MS
    );
  }
  return false; // failed / unknown
}

export function buildStats(): NodeStats[] {
  const samples = latestSamples();
  const used = (labId: number, sid: number | "L", pool: string): number | null =>
    samples.get(`${labId}:${sid}:${pool}`)?.used ?? null;
  const cell = (labId: number, pool: string) => {
    const c = samples.get(`${labId}:L:${pool}`);
    return { used: c?.used ?? null, quota: c?.quota ?? null };
  };

  const labs = listLabs();
  const scans = latestUsageScans();
  const now = Date.now();
  const byNode = new Map<string, NodeStats>();

  for (const lab of labs) {
    const members = listMembers(lab.id);
    const students: StudentUsage[] = members.map((m) => ({
      studentId: m.id,
      username: m.username,
      name: m.name ?? null,
      docker: used(lab.id, m.id, "docker"),
      fast: used(lab.id, m.id, "fast"),
      slow: used(lab.id, m.id, "slow"),
    }));
    students.sort((a, b) => (b.docker ?? 0) - (a.docker ?? 0) || a.username.localeCompare(b.username));

    const usageScannedAt = lab.usage_scanned_at ?? null;
    const labStats: LabStats = {
      labId: lab.id,
      labName: lab.name,
      image: lab.image,
      students,
      live: {
        image: cell(lab.id, "docker").used,
        fast: cell(lab.id, "fast"),
        slow: cell(lab.id, "slow"),
      },
      usageScannedAt,
      scanStale: usageScannedAt === null || now - usageScannedAt > USAGE_STALE_MS,
      scanPending: isScanPending(scans.get(`${lab.node_name}::${lab.name}`), usageScannedAt, now),
    };

    let node = byNode.get(lab.node_name);
    if (!node) {
      node = { node: lab.node_name, online: lab.online, labs: [], totalImageBytes: 0 };
      byNode.set(lab.node_name, node);
    }
    node.labs.push(labStats);
    node.totalImageBytes += labStats.live.image ?? 0;
  }

  const nodes = [...byNode.values()];
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  for (const n of nodes) n.labs.sort((a, b) => a.labName.localeCompare(b.labName));
  return nodes;
}

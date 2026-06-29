/**
 * Storage stats, grouped node -> placement -> student, for the Stats page. A lab can run on several
 * nodes, so each block is a PLACEMENT (lab on one node). Two separately-cadenced kinds of data, both
 * read from the latest `storage_samples` row per (placement, student, pool):
 *
 *   - PLACEMENT-LEVEL (`LabStats.live`): the whole-container writable layer ("whole image",
 *     pool=docker, student_id NULL) plus the placement's fast/cold ZFS usage-vs-quota. The agent
 *     recomputes these every ~5 min and re-reports them each heartbeat, so they carry a freshness ts.
 *   - NIGHTLY per-student (`LabStats.students`): each student's docker home, scratch, cold `du` from
 *     the per-student usage scan (nightly + on-demand "Scan now").
 */

import { db } from "./db";
import { listAllPlacements } from "./placements";
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
  labId: number; // logical lab id (the link target)
  placementId: number; // the placement this block represents (scan target)
  labName: string;
  image: string;
  students: StudentUsage[];
  live: {
    image: number | null; // whole-container writable layer (SizeRw) for the lab container
    fast: { used: number | null; quota: number | null };
    slow: { used: number | null; quota: number | null };
  };
  liveUpdatedAt: number | null;
  liveStale: boolean;
  usageScannedAt: number | null;
  scanStale: boolean;
  scanPending: boolean;
}

const USAGE_STALE_MS = 25 * 60 * 60 * 1000;
const LIVE_STALE_MS = 15 * 60 * 1000;

export interface NodeStats {
  node: string;
  online: number;
  labs: LabStats[]; // placements on this node
  totalImageBytes: number;
}

interface Cell {
  used: number;
  quota: number | null;
  ts: number;
}

/** Latest sample per (placement, student|placement-level, pool), indexed for O(1) lookup. */
function latestSamples(): Map<string, Cell> {
  const rows = db()
    .prepare(
      `SELECT s.placement_id AS placement_id, s.student_id AS student_id, s.pool AS pool,
              s.used_bytes AS used, s.quota_bytes AS quota, s.ts AS ts
       FROM storage_samples s
       WHERE s.placement_id IS NOT NULL
         AND s.ts = (SELECT MAX(ts) FROM storage_samples s2
                     WHERE s2.placement_id = s.placement_id AND s2.pool = s.pool
                       AND ((s2.student_id IS NULL AND s.student_id IS NULL)
                            OR s2.student_id = s.student_id))`,
    )
    .all() as { placement_id: number; student_id: number | null; pool: string; used: number; quota: number | null; ts: number }[];
  const map = new Map<string, Cell>();
  for (const r of rows) {
    map.set(`${r.placement_id}:${r.student_id ?? "L"}:${r.pool}`, { used: r.used, quota: r.quota, ts: r.ts });
  }
  return map;
}

const SCAN_INGEST_GRACE_MS = 10 * 60 * 1000;

/** Most-recent usage.scan task per `${node}::${labName}`. */
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

function isScanPending(
  scan: { state: string; createdAt: number } | undefined,
  usageScannedAt: number | null,
  now: number,
): boolean {
  if (!scan) return false;
  if (scan.state === "queued" || scan.state === "sent") return true;
  if (scan.state === "ok") {
    return (
      (usageScannedAt === null || usageScannedAt < scan.createdAt) &&
      now - scan.createdAt < SCAN_INGEST_GRACE_MS
    );
  }
  return false;
}

export function buildStats(): NodeStats[] {
  const samples = latestSamples();
  const used = (pid: number, sid: number | "L", pool: string): number | null =>
    samples.get(`${pid}:${sid}:${pool}`)?.used ?? null;
  const cell = (pid: number, pool: string) => {
    const c = samples.get(`${pid}:L:${pool}`);
    return { used: c?.used ?? null, quota: c?.quota ?? null };
  };

  const scans = latestUsageScans();
  const now = Date.now();
  const byNode = new Map<string, NodeStats>();

  for (const p of listAllPlacements()) {
    const members = listMembers(p.lab_id);
    const students: StudentUsage[] = members.map((m) => ({
      studentId: m.id,
      username: m.username,
      name: m.name ?? null,
      docker: used(p.id, m.id, "docker"),
      fast: used(p.id, m.id, "fast"),
      slow: used(p.id, m.id, "slow"),
    }));
    students.sort((a, b) => (b.docker ?? 0) - (a.docker ?? 0) || a.username.localeCompare(b.username));

    const usageScannedAt = p.usage_scanned_at ?? null;
    const liveTs = (["docker", "fast", "slow"] as const)
      .map((pool) => samples.get(`${p.id}:L:${pool}`)?.ts)
      .filter((t): t is number => typeof t === "number");
    const liveUpdatedAt = liveTs.length ? Math.max(...liveTs) : null;

    const labStats: LabStats = {
      labId: p.lab_id,
      placementId: p.id,
      labName: p.lab_name,
      image: p.image,
      students,
      live: {
        image: cell(p.id, "docker").used,
        fast: cell(p.id, "fast"),
        slow: cell(p.id, "slow"),
      },
      liveUpdatedAt,
      liveStale: liveUpdatedAt === null || now - liveUpdatedAt > LIVE_STALE_MS,
      usageScannedAt,
      scanStale: usageScannedAt === null || now - usageScannedAt > USAGE_STALE_MS,
      scanPending: isScanPending(scans.get(`${p.node_name}::${p.lab_name}`), usageScannedAt, now),
    };

    let node = byNode.get(p.node_name);
    if (!node) {
      node = { node: p.node_name, online: p.online, labs: [], totalImageBytes: 0 };
      byNode.set(p.node_name, node);
    }
    node.labs.push(labStats);
    node.totalImageBytes += labStats.live.image ?? 0;
  }

  const nodes = [...byNode.values()];
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  for (const n of nodes) n.labs.sort((a, b) => a.labName.localeCompare(b.labName));
  return nodes;
}

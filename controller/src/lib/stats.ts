/**
 * Per-student storage stats, grouped node -> lab -> student, for the Stats page. All numbers come
 * from the latest `storage_samples` row per (lab, student, pool); the agent reports three pools:
 *   - docker: a student's writable-layer / overlayfs usage (installed software in their home);
 *             the lab-level (student_id NULL) docker row is the whole container's writable layer.
 *   - fast:   scratch tier (per-student is usually null — the lab quota covers everyone).
 *   - slow:   cold-storage tier (likewise usually lab-level only).
 */

import { db } from "./db";
import { listLabs } from "./labs";
import { listMembers } from "./students";

export interface StudentUsage {
  studentId: number;
  username: string;
  name: string | null;
  docker: number | null; // overlay/image usage attributed to this student
  fast: number | null; // scratch
  slow: number | null; // cold storage
}

export interface LabStats {
  labId: number;
  labName: string;
  image: string;
  students: StudentUsage[];
  aggregate: {
    docker: number | null; // whole-image writable layer (SizeRw) for the lab container
    fast: { used: number | null; quota: number | null };
    slow: { used: number | null; quota: number | null };
  };
}

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

export function buildStats(): NodeStats[] {
  const samples = latestSamples();
  const used = (labId: number, sid: number | "L", pool: string): number | null =>
    samples.get(`${labId}:${sid}:${pool}`)?.used ?? null;
  const cell = (labId: number, pool: string) => {
    const c = samples.get(`${labId}:L:${pool}`);
    return { used: c?.used ?? null, quota: c?.quota ?? null };
  };

  const labs = listLabs();
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

    const labStats: LabStats = {
      labId: lab.id,
      labName: lab.name,
      image: lab.image,
      students,
      aggregate: {
        docker: cell(lab.id, "docker").used,
        fast: cell(lab.id, "fast"),
        slow: cell(lab.id, "slow"),
      },
    };

    let node = byNode.get(lab.node_name);
    if (!node) {
      node = { node: lab.node_name, online: lab.online, labs: [], totalImageBytes: 0 };
      byNode.set(lab.node_name, node);
    }
    node.labs.push(labStats);
    node.totalImageBytes += labStats.aggregate.docker ?? 0;
  }

  const nodes = [...byNode.values()];
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  for (const n of nodes) n.labs.sort((a, b) => a.labName.localeCompare(b.labName));
  return nodes;
}

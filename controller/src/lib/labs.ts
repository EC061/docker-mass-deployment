/**
 * Logical labs: node-independent records (name + PI metadata + roster). A lab runs on zero or more
 * nodes via `lab_placements` (see placements.ts) — all node/quota/image/port config lives there.
 */

import { audit } from "./audit";
import { db } from "./db";
import { destroyPlacement, listPlacements } from "./placements";

export { audit } from "./audit"; // re-exported for back-compat with existing importers

// Lab names become ZFS dataset components and the docker container name on a node. A leading
// alphanumeric then alphanumerics/hyphen/underscore, no slashes/dots/whitespace, <= 40 (M-04).
export const LAB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

export function isValidLabName(name: string): boolean {
  return LAB_NAME_RE.test(name);
}

export interface Lab {
  id: number;
  name: string;
  pi_name: string | null;
  pi_email: string | null;
  created_at: number;
  updated_at: number;
}

/** A lab plus the derived counts shown on the Labs list page. */
export interface LabSummary extends Lab {
  student_count: number;
  placement_count: number;
  active_placements: number;
}

export function listLabs(): LabSummary[] {
  return db()
    .prepare(
      `SELECT labs.*,
              (SELECT COUNT(*) FROM lab_members WHERE lab_members.lab_id = labs.id) AS student_count,
              (SELECT COUNT(*) FROM lab_placements WHERE lab_placements.lab_id = labs.id) AS placement_count,
              (SELECT COUNT(*) FROM lab_placements WHERE lab_placements.lab_id = labs.id AND state = 'active') AS active_placements
       FROM labs ORDER BY labs.name`,
    )
    .all() as LabSummary[];
}

export function getLab(id: number): Lab | undefined {
  return db().prepare("SELECT * FROM labs WHERE id = ?").get(id) as Lab | undefined;
}

export function getLabByName(name: string): Lab | undefined {
  return db().prepare("SELECT * FROM labs WHERE name = ?").get(name) as Lab | undefined;
}

export interface CreateLabInput {
  name: string;
  piName?: string;
  piEmail?: string;
  actor?: string;
}

export function createLab(input: CreateLabInput): Lab {
  if (!isValidLabName(input.name)) {
    throw new Error("Invalid lab name (use letters, digits, hyphen or underscore; max 40 chars)");
  }
  if (getLabByName(input.name)) throw new Error(`A lab named '${input.name}' already exists`);
  const now = Date.now();
  const info = db()
    .prepare(
      "INSERT INTO labs (name, pi_name, pi_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.name, input.piName ?? null, input.piEmail ?? null, now, now);
  audit(input.actor, "lab.create", input.name);
  return getLab(Number(info.lastInsertRowid))!;
}

export interface UpdateLabMetaInput {
  piName?: string | null;
  piEmail?: string | null;
}

/** Edit a lab's PI metadata. Node/quota/image config is changed on the placement, not here. */
export function updateLabMeta(labId: number, input: UpdateLabMetaInput, actor?: string): void {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  if (input.piName !== undefined) {
    db().prepare("UPDATE labs SET pi_name = ? WHERE id = ?").run(input.piName || null, labId);
  }
  if (input.piEmail !== undefined) {
    db().prepare("UPDATE labs SET pi_email = ? WHERE id = ?").run(input.piEmail || null, labId);
  }
  db().prepare("UPDATE labs SET updated_at = ? WHERE id = ?").run(Date.now(), labId);
  audit(actor, "lab.update_meta", lab.name);
}

export interface DestroyLabResult {
  deleted: boolean; // the logical lab row was removed
  teardownStarted: number; // placements told to tear down (lab kept until they confirm)
}

/**
 * Delete a logical lab. If it still has placements, each is told to tear down (the placement rows are
 * kept in `deleting` until their node confirms — see confirmPlacementDestroyed) and the lab row is
 * preserved; call again once teardown completes. With no placements left, the lab and its roster are
 * removed and any now-membership-less student is dropped.
 */
export function destroyLab(labId: number, actor?: string): DestroyLabResult {
  const lab = getLab(labId);
  if (!lab) return { deleted: false, teardownStarted: 0 };

  const placements = listPlacements(labId);
  for (const p of placements) destroyPlacement(p.id, actor);
  if (placements.length > 0) {
    // Wait for the nodes to confirm destruction before removing the logical lab.
    return { deleted: false, teardownStarted: placements.length };
  }

  const memberIds = (db()
    .prepare("SELECT student_id FROM lab_members WHERE lab_id = ?")
    .all(labId) as { student_id: number }[]).map((r) => r.student_id);
  db().prepare("DELETE FROM labs WHERE id = ?").run(labId); // cascades lab_members

  let orphansRemoved = 0;
  for (const sid of memberIds) {
    const stillMember = db().prepare("SELECT 1 FROM lab_members WHERE student_id = ? LIMIT 1").get(sid);
    if (!stillMember) {
      db().prepare("DELETE FROM students WHERE id = ?").run(sid);
      orphansRemoved++;
    }
  }
  audit(actor, "lab.delete", lab.name, orphansRemoved ? `${orphansRemoved} students removed` : undefined);
  return { deleted: true, teardownStarted: 0 };
}

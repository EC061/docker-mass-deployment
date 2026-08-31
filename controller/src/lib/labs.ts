/**
 * Logical labs: node-independent records (name + PI metadata + roster). A lab runs on zero or more
 * nodes via `lab_placements` (see placements.ts) — all node/quota/image/port config lives there.
 */

import { audit } from "./audit";
import { db } from "./db";
import { destroyPlacement, forceDeletePlacement, listPlacements } from "./placements";

export { audit } from "./audit"; // re-exported for back-compat with existing importers

// Lab names become ZFS dataset components and the docker container name on a node. A leading
// alphanumeric then alphanumerics/hyphen/underscore, no slashes/dots/whitespace, <= 40 (M-04).
export const LAB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

// A lab alias is only ever used as the lab half of a container hostname, so it is restricted to the
// RFC 1123 label set — no underscore. The agent folds anything illegal to '-', and an alias that
// silently came back different from what was typed would be worse than refusing it here.
export const LAB_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$/;

export function isValidLabName(name: string): boolean {
  return LAB_NAME_RE.test(name);
}

export function isValidLabAlias(alias: string): boolean {
  return LAB_ALIAS_RE.test(alias);
}

export interface Lab {
  id: number;
  name: string;
  /** Optional hostname alias. When set, containers are named `<alias>-<node>` instead of
   *  `<name>-<node>` — see labs.alias in db.ts and container_hostname in the agent. */
  alias: string | null;
  pi_name: string | null;
  pi_email: string | null;
  pi_student_id: number | null;
  created_at: number;
  updated_at: number;
}

/** A lab plus the derived counts shown on the Labs list page. */
export interface LabSummary extends Lab {
  student_count: number;
  placement_count: number;
  active_placements: number;
}

export interface LabPlacementSummary {
  lab_id: number;
  id: number;
  node_name: string;
  state: string;
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

/** Placement labels for the Labs index, fetched in one query to avoid a per-lab waterfall. */
export function listLabPlacementSummaries(): LabPlacementSummary[] {
  return db()
    .prepare(
      `SELECT p.lab_id, p.id, nodes.name AS node_name, p.state
       FROM lab_placements p JOIN nodes ON nodes.id = p.node_id
       ORDER BY p.lab_id, nodes.name`,
    )
    .all() as LabPlacementSummary[];
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

/** The nodes a lab is currently placed on, for the messages that refuse an identity change. */
function placedNodeNames(labId: number): string[] {
  return (db()
    .prepare(
      `SELECT nodes.name AS name FROM lab_placements p JOIN nodes ON nodes.id = p.node_id
       WHERE p.lab_id = ? ORDER BY nodes.name`,
    )
    .all(labId) as { name: string }[]).map((r) => r.name);
}

/**
 * Rename a logical lab.
 *
 * The name is the lab's identity everywhere below the controller: the ZFS dataset component
 * (`<pool>/labs/<name>`), the container name, the key in every task param, log line and GPU event.
 * Nothing in the agent protocol can migrate those, so a rename is only offered while the lab has no
 * placement. To change only what students see in their shell prompt, set an alias instead.
 */
export function renameLab(labId: number, name: string, actor?: string): void {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const clean = name.trim();
  if (clean === lab.name) return;
  if (!isValidLabName(clean)) {
    throw new Error("Invalid lab name (use letters, digits, hyphen or underscore; max 40 chars)");
  }
  const placed = placedNodeNames(labId);
  if (placed.length > 0) {
    throw new Error(
      `'${lab.name}' cannot be renamed while it is placed on ${placed.join(", ")} — the lab name is ` +
        "its ZFS dataset and container name on the node. Remove node access first, or set an alias " +
        "to change only the hostname students see.",
    );
  }
  if (getLabByName(clean)) throw new Error(`A lab named '${clean}' already exists`);
  db().prepare("UPDATE labs SET name = ?, updated_at = ? WHERE id = ?").run(clean, Date.now(), labId);
  audit(actor, "lab.rename", lab.name, clean);
}

/**
 * Set (or clear, with an empty value) a lab's hostname alias. Purely cosmetic — it replaces the lab
 * half of the container hostname. Returns the nodes whose container must be recreated for it to take
 * effect, because a container's hostname is fixed at creation.
 */
export function setLabAlias(labId: number, alias: string | null, actor?: string): string[] {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const clean = (alias ?? "").trim();
  if (clean && !isValidLabAlias(clean)) {
    throw new Error(
      "Invalid lab alias (use letters, digits or hyphen — no underscore, since it becomes a hostname; max 40 chars)",
    );
  }
  const next = clean || null;
  if (next === lab.alias) return [];
  db().prepare("UPDATE labs SET alias = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), labId);
  audit(actor, "lab.set_alias", lab.name, next ?? "(cleared)");
  return placedNodeNames(labId);
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
 *
 * `force` unblocks a lab stuck behind offline nodes: placements on offline nodes are purged from the
 * controller immediately (see forceDeletePlacement) while online nodes still get a normal teardown.
 * If every placement was purged, the lab row is removed in the same call.
 */
export function destroyLab(labId: number, actor?: string, force = false): DestroyLabResult {
  const lab = getLab(labId);
  if (!lab) return { deleted: false, teardownStarted: 0 };

  // Tear SMB clients down before their local-ZFS owners, so an owner that still has dependents
  // never blocks the loop (destroyPlacement refuses to remove an owner while clients depend on it).
  const placements = listPlacements(labId).sort(
    (a, b) => (a.node_cold_backend === "smb" ? 0 : 1) - (b.node_cold_backend === "smb" ? 0 : 1),
  );
  let teardownStarted = 0;
  for (const p of placements) {
    if (force && !p.online) {
      forceDeletePlacement(p.id, actor);
    } else {
      destroyPlacement(p.id, actor);
      teardownStarted++;
    }
  }
  if (teardownStarted > 0) {
    // Wait for the nodes to confirm destruction before removing the logical lab.
    return { deleted: false, teardownStarted };
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

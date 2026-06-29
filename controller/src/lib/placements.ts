/**
 * Lab placements: one logical lab running on one node. A placement carries the node-specific quotas,
 * SSH port, image, and container options, plus its provisioning lifecycle state. Creating, quota-
 * changing, recreating, or destroying a placement updates the authoritative row and enqueues the
 * matching task to that node's agent.
 *
 * `placement_members` track each student's provisioning state on each placement, so a per-node
 * failure stays visible and retryable without blocking the others.
 */

import { audit } from "./audit";
import { db } from "./db";
import { sendCredentialEmail } from "./mailer";
import { generatePassword } from "./passwords";
import { enqueueTask } from "./queue";
import { getSetting } from "./settings";

export interface ContainerOptions {
  cpus: string;
  memory: string;
  shm_size: string;
  image_quota: string;
  restart: string;
}

export const DEFAULT_CONTAINER_OPTIONS: ContainerOptions = {
  cpus: "4",
  memory: "8g",
  shm_size: "1g",
  image_quota: "300g",
  restart: "unless-stopped",
};

// Mirrors the agent's docker.IMAGE_RE: optional registry/repo path, optional :tag and/or @sha256.
const DOCKER_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;
// A docker size value, e.g. "8g", "512m", "1.5g" (optional unit, optional trailing b).
const SIZE_RE = /^\d+(\.\d+)?\s*[kKmMgGtT]?[bB]?$/;
const RESTART_POLICIES = new Set(["no", "on-failure", "always", "unless-stopped"]);

/** Validate an image reference + all container resource values before queueing work. Throws on the
 *  first invalid field so create/recreate never enqueue a doomed run. */
export function validateContainerConfig(image: string, opts: ContainerOptions): void {
  if (!DOCKER_IMAGE_RE.test(image) || image.length > 256) {
    throw new Error(`Invalid image reference '${image}'`);
  }
  if (!/^\d+(\.\d+)?$/.test(opts.cpus)) throw new Error("CPUs must be a number (e.g. 4 or 2.5)");
  if (!SIZE_RE.test(opts.memory)) throw new Error("Invalid memory size (e.g. 8g, 512m)");
  if (!SIZE_RE.test(opts.shm_size)) throw new Error("Invalid shared-memory size (e.g. 1g)");
  if (!SIZE_RE.test(opts.image_quota)) throw new Error("Invalid image-size quota (e.g. 300g)");
  if (!RESTART_POLICIES.has(opts.restart)) {
    throw new Error("Restart policy must be one of: no, on-failure, always, unless-stopped");
  }
}

/** Parse a placement's stored container_options JSON, filling any missing keys with defaults. */
export function containerOptionsOf(p: { container_options: string | null }): ContainerOptions {
  let parsed: Partial<ContainerOptions> = {};
  if (p.container_options) {
    try {
      parsed = JSON.parse(p.container_options) as Partial<ContainerOptions>;
    } catch {
      parsed = {};
    }
  }
  return { ...DEFAULT_CONTAINER_OPTIONS, ...parsed };
}

export type PlacementState = "queued" | "provisioning" | "active" | "failed" | "deleting";
export type MemberState = "queued" | "provisioning" | "active" | "failed" | "removing";

export interface Placement {
  id: number;
  lab_id: number;
  lab_name: string;
  node_id: number;
  node_name: string;
  online: number;
  fast_quota_bytes: number;
  cold_quota_bytes: number | null; // NULL on SMB-client placements (owner manages cold)
  ssh_port: number;
  image: string;
  container_options: string | null;
  state: PlacementState;
  last_error: string | null;
  usage_scanned_at: number | null;
  last_usage_scan: number | null;
  created_at: number;
  updated_at: number;
  // Joined from the node (cold-storage backend matters for quota + safe student-data deletion).
  node_cold_backend: "local_zfs" | "smb";
  node_cold_owner_node_id: number | null;
  node_cold_ready: number;
}

const PLACEMENT_SELECT = `
  SELECT p.*, labs.name AS lab_name, nodes.name AS node_name, nodes.online AS online,
         nodes.cold_backend AS node_cold_backend, nodes.cold_owner_node_id AS node_cold_owner_node_id,
         nodes.cold_ready AS node_cold_ready
  FROM lab_placements p
  JOIN labs ON labs.id = p.lab_id
  JOIN nodes ON nodes.id = p.node_id`;

export function listPlacements(labId: number): Placement[] {
  return db().prepare(`${PLACEMENT_SELECT} WHERE p.lab_id = ? ORDER BY nodes.name`).all(labId) as Placement[];
}

export function listPlacementsForNode(nodeId: number): Placement[] {
  return db().prepare(`${PLACEMENT_SELECT} WHERE p.node_id = ? ORDER BY labs.name`).all(nodeId) as Placement[];
}

export function listAllPlacements(): Placement[] {
  return db().prepare(`${PLACEMENT_SELECT} ORDER BY labs.name, nodes.name`).all() as Placement[];
}

export function getPlacement(id: number): Placement | undefined {
  return db().prepare(`${PLACEMENT_SELECT} WHERE p.id = ?`).get(id) as Placement | undefined;
}

export function getPlacementByLabNode(labName: string, nodeName: string): Placement | undefined {
  return db()
    .prepare(`${PLACEMENT_SELECT} WHERE labs.name = ? AND nodes.name = ?`)
    .get(labName, nodeName) as Placement | undefined;
}

/** True if the lab already has a placement on the node (the (lab_id,node_id) uniqueness target). */
export function placementExists(labId: number, nodeId: number): boolean {
  return !!db()
    .prepare("SELECT 1 FROM lab_placements WHERE lab_id = ? AND node_id = ?")
    .get(labId, nodeId);
}

/** Lowest SSH port in the configured range not already used by a placement ON THIS NODE (ports are
 *  allocated per node, not globally). */
export function nextSshPortForNode(nodeId: number): number {
  const start = getSetting("sshPortStart");
  const end = getSetting("sshPortEnd");
  const used = new Set(
    (db()
      .prepare("SELECT ssh_port FROM lab_placements WHERE node_id = ?")
      .all(nodeId) as { ssh_port: number }[]).map((r) => r.ssh_port),
  );
  for (let p = start; p <= end; p++) if (!used.has(p)) return p;
  throw new Error("No free SSH port in the configured range on this node");
}

function touch(placementId: number): void {
  db().prepare("UPDATE lab_placements SET updated_at = ? WHERE id = ?").run(Date.now(), placementId);
}

/** Build the lab.create / container.recreate container_options payload from a placement. */
function taskContainerOptions(p: Placement): Record<string, unknown> {
  return { ...containerOptionsOf(p), image: p.image, ssh_port: p.ssh_port };
}

export interface CreatePlacementInput {
  labId: number;
  nodeId: number;
  fastQuotaBytes: number;
  coldQuotaBytes: number | null; // null for SMB-client placements
  sshPort: number;
  image: string;
  containerOptions: ContainerOptions;
  actor?: string;
}

/**
 * Grant a lab access to a node: insert the placement, enqueue lab.create, then provision every
 * current roster member on it. Returns the new placement.
 */
export async function createPlacement(input: CreatePlacementInput): Promise<Placement> {
  const node = db()
    .prepare("SELECT id, name, cold_backend, cold_owner_node_id, cold_ready FROM nodes WHERE id = ?")
    .get(input.nodeId) as
    | { id: number; name: string; cold_backend: string; cold_owner_node_id: number | null; cold_ready: number }
    | undefined;
  if (!node) throw new Error("Unknown node");
  validateContainerConfig(input.image, input.containerOptions);

  // SMB-client assignment rules: cold is the owner node's shared dataset over a mount, so this
  // placement carries NO local cold quota, and the owner must already host this lab (active) with its
  // cold dataset created and the SMB mount live before we provision the client.
  let coldQuota = input.coldQuotaBytes;
  if (node.cold_backend === "smb") {
    coldQuota = null;
    if (!node.cold_owner_node_id) {
      throw new Error(`node '${node.name}' is an SMB client without a cold-storage owner — configure it on the Nodes page`);
    }
    const owner = db().prepare("SELECT name FROM nodes WHERE id = ?").get(node.cold_owner_node_id) as { name: string };
    const ownerPlacement = db()
      .prepare("SELECT state FROM lab_placements WHERE lab_id = ? AND node_id = ?")
      .get(input.labId, node.cold_owner_node_id) as { state: string } | undefined;
    if (!ownerPlacement) {
      throw new Error(`grant the cold-storage owner '${owner.name}' access to this lab first (its cold dataset must exist before an SMB client)`);
    }
    if (ownerPlacement.state !== "active") {
      throw new Error(`the owner '${owner.name}' placement is '${ownerPlacement.state}'; wait until it is active before adding the SMB client`);
    }
    if (node.cold_ready !== 1) {
      throw new Error(`the SMB cold-storage mount on '${node.name}' is not an active mount yet`);
    }
  } else if (coldQuota === null) {
    throw new Error("a local-ZFS placement requires a cold quota");
  }

  const now = Date.now();
  const info = db()
    .prepare(
      `INSERT INTO lab_placements
         (lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, container_options,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
    )
    .run(
      input.labId,
      input.nodeId,
      input.fastQuotaBytes,
      coldQuota,
      input.sshPort,
      input.image,
      JSON.stringify(input.containerOptions),
      now,
      now,
    );
  const placement = getPlacement(Number(info.lastInsertRowid))!;

  enqueueTask(
    placement.node_name,
    "lab.create",
    {
      lab: placement.lab_name,
      fast_quota_bytes: placement.fast_quota_bytes,
      slow_quota_bytes: placement.cold_quota_bytes ?? 0,
      image: placement.image,
      ssh_port: placement.ssh_port,
      container_options: taskContainerOptions(placement),
    },
    input.actor,
  );
  audit(input.actor, "placement.create", `${placement.lab_name}@${placement.node_name}`);

  // Provision the lab's current roster on the new placement.
  const roster = db()
    .prepare(
      `SELECT students.id AS id, students.username AS username, students.email AS email,
              students.name AS name, students.student_id AS student_id
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? ORDER BY students.username`,
    )
    .all(input.labId) as ProvisionStudent[];
  for (const s of roster) await provisionMemberOnPlacement(placement, s, input.actor);

  return placement;
}

export interface ProvisionStudent {
  id: number;
  username: string;
  email: string | null;
  name: string | null;
  student_id: string | null;
}

export interface MemberProvision {
  node: string;
  password: string;
  emailed: boolean;
}

/**
 * Provision one student on one placement: record the placement_member, enqueue student.add with a
 * freshly generated per-node password, and email the credentials (best-effort). Idempotent — a
 * student already provisioned on the placement is skipped (no duplicate account/email).
 */
export async function provisionMemberOnPlacement(
  placement: Placement,
  student: ProvisionStudent,
  actor?: string,
): Promise<MemberProvision | null> {
  const existing = db()
    .prepare("SELECT id FROM placement_members WHERE placement_id = ? AND student_id = ?")
    .get(placement.id, student.id);
  if (existing) return null;

  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO placement_members (placement_id, student_id, state, created_at, updated_at)
       VALUES (?, ?, 'provisioning', ?, ?)`,
    )
    .run(placement.id, student.id, now, now);

  const password = generatePassword();
  enqueueTask(
    placement.node_name,
    "student.add",
    { lab: placement.lab_name, username: student.username, password },
    actor,
  );

  let emailed = false;
  if (student.email) {
    const host = getSetting("sshHostOverride").trim() || placement.node_name;
    const res = await sendCredentialEmail({
      to: student.email,
      name: student.name ?? undefined,
      username: student.username,
      password,
      host,
      port: placement.ssh_port,
      lab: placement.lab_name,
      node: placement.node_name,
      studentId: student.student_id,
    });
    emailed = res.sent;
  }
  return { node: placement.node_name, password, emailed };
}

/**
 * Remove one student from one placement: enqueue student.remove and drop the placement_member.
 * delete_cold is true only on a local-ZFS placement (which owns its cold dataset); an SMB client is
 * told delete_cold=false so it can never erase the owner's shared cold data — the owner deletes it
 * exactly once. delete_data (fast, node-local) is honored on every placement.
 */
export function removeMemberFromPlacement(
  placement: Placement,
  student: { id: number; username: string },
  deleteData: boolean,
  actor?: string,
): void {
  const deleteCold = deleteData && placement.node_cold_backend === "local_zfs";
  enqueueTask(
    placement.node_name,
    "student.remove",
    { lab: placement.lab_name, username: student.username, delete_data: deleteData, delete_cold: deleteCold },
    actor,
  );
  db()
    .prepare("DELETE FROM placement_members WHERE placement_id = ? AND student_id = ?")
    .run(placement.id, student.id);
}

/** Live quota change (no recreate). Routes to lab.set_quota on the placement's node. */
export function updatePlacementQuota(
  placementId: number,
  input: { fastQuotaBytes?: number; coldQuotaBytes?: number | null },
  actor?: string,
): void {
  const p = getPlacement(placementId);
  if (!p) throw new Error("Unknown placement");
  const params: Record<string, unknown> = { lab: p.lab_name };
  if (input.fastQuotaBytes !== undefined) {
    db().prepare("UPDATE lab_placements SET fast_quota_bytes = ? WHERE id = ?").run(input.fastQuotaBytes, placementId);
    params.fast_quota_bytes = input.fastQuotaBytes;
  }
  if (input.coldQuotaBytes !== undefined) {
    db().prepare("UPDATE lab_placements SET cold_quota_bytes = ? WHERE id = ?").run(input.coldQuotaBytes, placementId);
    if (input.coldQuotaBytes !== null) params.slow_quota_bytes = input.coldQuotaBytes;
  }
  touch(placementId);
  enqueueTask(p.node_name, "lab.set_quota", params, actor);
  audit(actor, "placement.set_quota", `${p.lab_name}@${p.node_name}`, JSON.stringify(params));
}

/** Recreate the container with a (possibly changed) image / container options. Preserves data. */
export function recreatePlacement(
  placementId: number,
  input: { image?: string; containerOptions?: ContainerOptions },
  actor?: string,
): void {
  const p = getPlacement(placementId);
  if (!p) throw new Error("Unknown placement");
  // Validate the resulting (merged) config before changing anything or queueing the recreate.
  validateContainerConfig(
    input.image ?? p.image,
    input.containerOptions ?? containerOptionsOf(p),
  );
  if (input.image !== undefined) {
    db().prepare("UPDATE lab_placements SET image = ? WHERE id = ?").run(input.image, placementId);
  }
  if (input.containerOptions !== undefined) {
    db()
      .prepare("UPDATE lab_placements SET container_options = ? WHERE id = ?")
      .run(JSON.stringify(input.containerOptions), placementId);
  }
  touch(placementId);
  const fresh = getPlacement(placementId)!;
  enqueueTask(
    fresh.node_name,
    "container.recreate",
    {
      lab: fresh.lab_name,
      image: fresh.image,
      ssh_port: fresh.ssh_port,
      container_options: taskContainerOptions(fresh),
    },
    actor,
  );
  audit(actor, "placement.recreate", `${fresh.lab_name}@${fresh.node_name}`);
}

/**
 * Tear a placement down: mark it `deleting` and enqueue lab.destroy. The row is kept until the agent
 * confirms destruction (see confirmPlacementDestroyed) so a failed/queued teardown stays visible.
 */
export function destroyPlacement(placementId: number, actor?: string): void {
  const p = getPlacement(placementId);
  if (!p) return;
  // An owner (local-ZFS) placement holds the shared cold data for this lab's SMB clients — its
  // teardown would pull the rug out from under them, so block it until those clients are gone.
  if (p.node_cold_backend === "local_zfs") {
    const dependents = db()
      .prepare(
        `SELECT n.name FROM lab_placements lp JOIN nodes n ON n.id = lp.node_id
         WHERE lp.lab_id = ? AND n.cold_owner_node_id = ?`,
      )
      .all(p.lab_id, p.node_id) as { name: string }[];
    if (dependents.length > 0) {
      throw new Error(
        `'${p.lab_name}' on '${p.node_name}' owns the shared cold storage for SMB client(s): ${dependents.map((d) => d.name).join(", ")} — remove those placements first`,
      );
    }
  }
  db().prepare("UPDATE lab_placements SET state = 'deleting', updated_at = ? WHERE id = ?").run(Date.now(), placementId);
  enqueueTask(p.node_name, "lab.destroy", { lab: p.lab_name }, actor);
  audit(actor, "placement.destroy", `${p.lab_name}@${p.node_name}`);
}

/** Set a placement's lifecycle state (+ optional error) by id. */
export function markPlacementState(placementId: number, state: PlacementState, lastError?: string): void {
  db()
    .prepare("UPDATE lab_placements SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run(state, lastError ?? null, Date.now(), placementId);
}

/** Set a placement's state by (lab name, node name) — used by the result-ingest path in the hub. */
export function markPlacementStateByLabNode(
  labName: string,
  nodeName: string,
  state: PlacementState,
  lastError?: string,
): void {
  const p = getPlacementByLabNode(labName, nodeName);
  if (p) markPlacementState(p.id, state, lastError);
}

/** Set a placement_member's state by (lab, node, username) — used by the result-ingest path. */
export function markPlacementMemberState(
  labName: string,
  nodeName: string,
  username: string,
  state: MemberState,
  lastError?: string,
): void {
  const row = db()
    .prepare(
      `SELECT pm.id AS id FROM placement_members pm
       JOIN lab_placements p ON p.id = pm.placement_id
       JOIN labs ON labs.id = p.lab_id
       JOIN nodes ON nodes.id = p.node_id
       JOIN students ON students.id = pm.student_id
       WHERE labs.name = ? AND nodes.name = ? AND students.username = ?`,
    )
    .get(labName, nodeName, username) as { id: number } | undefined;
  if (row) {
    db()
      .prepare("UPDATE placement_members SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(state, lastError ?? null, Date.now(), row.id);
  }
}

/** Agent confirmed a lab.destroy: drop the placement row (cascades members + samples). */
export function confirmPlacementDestroyed(labName: string, nodeName: string): void {
  const p = getPlacementByLabNode(labName, nodeName);
  if (p && p.state === "deleting") {
    db().prepare("DELETE FROM lab_placements WHERE id = ?").run(p.id);
  }
}

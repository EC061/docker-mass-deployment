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
import { fmtBytes } from "./format";
import { sendCredentialEmail } from "./mailer";
import { generatePassword } from "./passwords";
import { enqueueTask } from "./queue";
import { decryptSecret, encryptSecret } from "./secrets";
import { getSetting } from "./settings";

export interface ContainerOptions {
  cpus: string;
  memory: string;
  shm_size: string;
  rootfs_quota: string;
  restart: string;
}

export const DEFAULT_CONTAINER_OPTIONS: ContainerOptions = {
  cpus: "4",
  memory: "8g",
  shm_size: "1g",
  rootfs_quota: "300g",
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
  if (!SIZE_RE.test(opts.rootfs_quota)) throw new Error("Invalid rootfs quota (e.g. 300g)");
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
  cold_owner_name: string | null;
  node_cold_ready: number;
}

const PLACEMENT_SELECT = `
  SELECT p.*, labs.name AS lab_name, nodes.name AS node_name, nodes.online AS online,
         nodes.cold_backend AS node_cold_backend, nodes.cold_owner_node_id AS node_cold_owner_node_id,
         owner.name AS cold_owner_name, nodes.cold_ready AS node_cold_ready
  FROM lab_placements p
  JOIN labs ON labs.id = p.lab_id
  JOIN nodes ON nodes.id = p.node_id
  LEFT JOIN nodes owner ON owner.id = nodes.cold_owner_node_id`;

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

function enqueuePlacementCreate(p: Placement, actor?: string): void {
  enqueueTask(
    p.node_name,
    "lab.create",
    {
      lab: p.lab_name,
      fast_quota_bytes: p.fast_quota_bytes,
      slow_quota_bytes: p.cold_quota_bytes ?? 0,
      image: p.image,
      ssh_port: p.ssh_port,
      container_options: taskContainerOptions(p),
    },
    actor,
  );
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
    .prepare("SELECT id, name, cold_backend, cold_owner_node_id, cold_ready, capabilities FROM nodes WHERE id = ?")
    .get(input.nodeId) as
    | { id: number; name: string; cold_backend: string; cold_owner_node_id: number | null; cold_ready: number; capabilities: string | null }
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
    const owner = db().prepare("SELECT name, capabilities FROM nodes WHERE id = ?").get(node.cold_owner_node_id) as
      { name: string; capabilities: string | null };
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
    const mapping = (raw: string | null) => {
      try {
        const runtime = (JSON.parse(raw ?? "{}") as any).runtime;
        if (Number.isInteger(runtime?.userns_start) && Number.isInteger(runtime?.userns_size)) {
          return `${runtime.userns_start}:${runtime.userns_size}`;
        }
      } catch { /* handled below */ }
      return null;
    };
    const clientMapping = mapping(node.capabilities);
    const ownerMapping = mapping(owner.capabilities);
    if (!clientMapping || !ownerMapping || clientMapping !== ownerMapping) {
      throw new Error(
        `SMB client '${node.name}' and owner '${owner.name}' must report the same Docker userns numeric mapping`,
      );
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

  enqueuePlacementCreate(placement, input.actor);
  audit(input.actor, "placement.create", `${placement.lab_name}@${placement.node_name}`);

  // Provision the lab's current roster on the new placement.
  const roster = db()
    .prepare(
      `SELECT students.id AS id, students.username AS username, students.email AS email,
              students.name AS name, students.student_id AS student_id,
              students.linux_uid AS linux_uid
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
  linux_uid: number;
}

export interface MemberProvision {
  node: string;
}

export interface PlacementMember {
  id: number;
  username: string;
  email: string | null;
  name: string | null;
  student_id: string | null;
  state: MemberState;
  last_error: string | null;
  credential_available: number;
  updated_at: number;
}

export function listPlacementMembers(placementId: number): PlacementMember[] {
  return db()
    .prepare(
      `SELECT students.id, students.username, students.email, students.name, students.student_id,
              pm.state, pm.last_error, CASE WHEN pm.credential_secret IS NULL THEN 0 ELSE 1 END AS credential_available,
              pm.updated_at
       FROM placement_members pm JOIN students ON students.id = pm.student_id
       WHERE pm.placement_id = ? ORDER BY students.username`,
    )
    .all(placementId) as PlacementMember[];
}

/**
 * Provision one student on one placement: record the placement_member and enqueue student.add with
 * a freshly generated per-node password. The encrypted credential stays controller-side until the
 * agent reports success; only then is it emailed or made available for a one-time admin reveal.
 * Idempotent — a student already provisioned on the placement is skipped.
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
  const password = generatePassword();
  db()
    .prepare(
      `INSERT INTO placement_members
         (placement_id, student_id, state, credential_secret, created_at, updated_at)
       VALUES (?, ?, 'provisioning', ?, ?, ?)`,
    )
    .run(placement.id, student.id, encryptSecret(password), now, now);

  enqueueTask(
    placement.node_name,
    "student.add",
    {
      lab: placement.lab_name,
      username: student.username,
      password,
      uid: student.linux_uid,
      gid: student.linux_uid,
    },
    actor,
  );

  return { node: placement.node_name };
}

interface PendingCredential {
  member_id: number;
  state: MemberState;
  credential_secret: string | null;
  email: string | null;
  name: string | null;
  username: string;
  student_id: string | null;
  lab_name: string;
  node_name: string;
  node_alias: string | null;
  ssh_port: number;
}

function pendingCredential(labName: string, nodeName: string, username: string): PendingCredential | null {
  const row = db()
    .prepare(
      `SELECT pm.id AS member_id, pm.state, pm.credential_secret,
              students.email, students.name, students.username, students.student_id,
              labs.name AS lab_name, nodes.name AS node_name, nodes.alias AS node_alias, p.ssh_port
       FROM placement_members pm
       JOIN students ON students.id = pm.student_id
       JOIN lab_placements p ON p.id = pm.placement_id
       JOIN labs ON labs.id = p.lab_id
       JOIN nodes ON nodes.id = p.node_id
       WHERE labs.name = ? AND nodes.name = ? AND students.username = ?`,
    )
    .get(labName, nodeName, username) as PendingCredential | undefined;
  return row ?? null;
}

/** Deliver a credential only after the placement member is active. Successful email burns the
 * encrypted copy; skipped/failed email leaves it available for a one-time admin reveal. */
export async function deliverPlacementCredential(
  labName: string,
  nodeName: string,
  username: string,
): Promise<boolean> {
  const pending = pendingCredential(labName, nodeName, username);
  if (!pending || pending.state !== "active" || !pending.credential_secret || !pending.email) return false;
  const password = decryptSecret(pending.credential_secret);
  if (!password) return false;
  const host = getSetting("sshHostOverride").trim() || pending.node_name;
  const result = await sendCredentialEmail({
    to: pending.email,
    name: pending.name ?? undefined,
    username: pending.username,
    password,
    host,
    port: pending.ssh_port,
    lab: pending.lab_name,
    node: pending.node_alias?.trim() || pending.node_name,
    studentId: pending.student_id,
  });
  if (!result.sent) return false;
  db()
    .prepare("UPDATE placement_members SET credential_secret = NULL, credential_delivered_at = ? WHERE id = ?")
    .run(Date.now(), pending.member_id);
  return true;
}

/** Burn and return a successfully-provisioned member's password for a one-time admin reveal. */
export function consumePlacementCredential(
  placementId: number,
  studentId: number,
  actor?: string,
): { username: string; password: string } {
  const row = db()
    .prepare(
      `SELECT pm.id AS member_id, pm.state, pm.credential_secret, students.username,
              labs.name AS lab_name, nodes.name AS node_name
       FROM placement_members pm
       JOIN students ON students.id = pm.student_id
       JOIN lab_placements p ON p.id = pm.placement_id
       JOIN labs ON labs.id = p.lab_id
       JOIN nodes ON nodes.id = p.node_id
       WHERE pm.placement_id = ? AND pm.student_id = ?`,
    )
    .get(placementId, studentId) as
    | { member_id: number; state: MemberState; credential_secret: string | null; username: string; lab_name: string; node_name: string }
    | undefined;
  if (!row || row.state !== "active") throw new Error("Credentials are available only after provisioning succeeds");
  if (!row.credential_secret) throw new Error("Credential was already delivered or revealed");
  const password = decryptSecret(row.credential_secret);
  if (!password) throw new Error("Credential could not be decrypted");
  db()
    .prepare("UPDATE placement_members SET credential_secret = NULL, credential_delivered_at = ? WHERE id = ?")
    .run(Date.now(), row.member_id);
  audit(actor, "placement.credential_reveal", `${row.lab_name}/${row.username}@${row.node_name}`);
  return { username: row.username, password };
}

/**
 * Remove one student account and its node-local fast home from one placement. Shared cold cleanup
 * is a separate owner-only task after every placement removal in the operation succeeds.
 */
export function removeMemberFromPlacement(
  placement: Placement,
  student: { id: number; username: string },
  deleteData: boolean,
  actor?: string,
  removal?: { id: string; coldCleanupNodes: string[] },
): void {
  enqueueTask(
    placement.node_name,
    "student.remove",
    {
      lab: placement.lab_name,
      username: student.username,
      delete_data: deleteData,
      ...(removal ? { removal_id: removal.id, cold_cleanup_nodes: removal.coldCleanupNodes } : {}),
    },
    actor,
  );
  db()
    .prepare("DELETE FROM placement_members WHERE placement_id = ? AND student_id = ?")
    .run(placement.id, student.id);
}

interface RemovalParams {
  lab?: string;
  username?: string;
  removal_id?: string;
  cold_cleanup_nodes?: string[];
}

/** Enqueue one cleanup for each locally-owned cold backing store, but only after all containers
 * removed the account and node-local fast home. Cached/repeated results cannot duplicate cleanup. */
export function completeStudentRemoval(taskUuid: string): void {
  const task = db()
    .prepare("SELECT params, requested_by FROM task_log WHERE task_uuid = ? AND action = 'student.remove' AND state = 'ok'")
    .get(taskUuid) as { params: string | null; requested_by: string | null } | undefined;
  if (!task?.params) return;
  let params: RemovalParams;
  try {
    params = JSON.parse(task.params) as RemovalParams;
  } catch {
    return;
  }
  if (!params.removal_id || !params.lab || !params.username) return;
  const states = db()
    .prepare(
      `SELECT state FROM task_log
       WHERE action = 'student.remove' AND json_extract(params, '$.removal_id') = ?`,
    )
    .all(params.removal_id) as { state: string }[];
  if (states.length === 0 || states.some((row) => row.state !== "ok")) return;

  for (const node of new Set(params.cold_cleanup_nodes ?? [])) {
    const exists = db()
      .prepare(
        `SELECT 1 FROM task_log WHERE node = ? AND action = 'student.delete_cold'
         AND json_extract(params, '$.removal_id') = ? LIMIT 1`,
      )
      .get(node, params.removal_id);
    if (!exists) {
      enqueueTask(
        node,
        "student.delete_cold",
        { lab: params.lab, username: params.username, removal_id: params.removal_id },
        task.requested_by ?? undefined,
      );
    }
  }
}

export interface NodePoolCapacity {
  fastBytes: number | null;
  coldBytes: number | null;
}

/** The node's actual ZFS pool sizes from the latest heartbeat telemetry (see stats.ts's parsePools
 * for the sibling reader). Null when the node hasn't reported yet — callers skip the cap in that case
 * rather than blocking quota changes on missing telemetry. */
export function nodePoolCapacityBytes(nodeId: number): NodePoolCapacity {
  const row = db().prepare("SELECT pools FROM nodes WHERE id = ?").get(nodeId) as { pools: string | null } | undefined;
  const sizeOf = (p: unknown): number | null =>
    p && typeof p === "object" && typeof (p as { size?: unknown }).size === "number" ? (p as { size: number }).size : null;
  if (!row?.pools) return { fastBytes: null, coldBytes: null };
  try {
    const arr = JSON.parse(row.pools) as unknown;
    if (!Array.isArray(arr)) return { fastBytes: null, coldBytes: null };
    return { fastBytes: sizeOf(arr[0]), coldBytes: sizeOf(arr[1]) };
  } catch {
    return { fastBytes: null, coldBytes: null };
  }
}

/** Live quota change (no recreate). Routes to lab.set_quota on the placement's node. */
export function updatePlacementQuota(
  placementId: number,
  input: { fastQuotaBytes?: number; coldQuotaBytes?: number | null },
  actor?: string,
): void {
  const p = getPlacement(placementId);
  if (!p) throw new Error("Unknown placement");
  const capacity = nodePoolCapacityBytes(p.node_id);
  if (input.fastQuotaBytes !== undefined && capacity.fastBytes !== null && input.fastQuotaBytes > capacity.fastBytes) {
    throw new Error(
      `Fast quota ${fmtBytes(input.fastQuotaBytes)} exceeds node '${p.node_name}'s fast pool capacity of ${fmtBytes(capacity.fastBytes)}`,
    );
  }
  if (
    input.coldQuotaBytes != null &&
    capacity.coldBytes !== null &&
    input.coldQuotaBytes > capacity.coldBytes
  ) {
    throw new Error(
      `Cold quota ${fmtBytes(input.coldQuotaBytes)} exceeds node '${p.node_name}'s cold pool capacity of ${fmtBytes(capacity.coldBytes)}`,
    );
  }
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

/**
 * Re-add every current member of a placement. Student accounts (useradd/chpasswd) live in the
 * container's writable layer, not the bind-mounted ZFS datasets, so container.recreate wipes them
 * even though their data survives — each member needs a fresh student.add after the container comes
 * back. The agent's task queue is a single-consumer FIFO per node, so tasks enqueued here after
 * container.recreate are guaranteed to run against the new container, not the old one.
 */
function reprovisionPlacementMembers(placement: Placement, actor?: string): void {
  const members = db()
    .prepare(
      `SELECT pm.id AS member_id, students.username AS username, students.linux_uid AS linux_uid
       FROM placement_members pm JOIN students ON students.id = pm.student_id
       WHERE pm.placement_id = ? ORDER BY students.username`,
    )
    .all(placement.id) as { member_id: number; username: string; linux_uid: number }[];
  const now = Date.now();
  for (const m of members) {
    const password = generatePassword();
    db()
      .prepare(
        `UPDATE placement_members
         SET state = 'provisioning', last_error = NULL, credential_secret = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(encryptSecret(password), now, m.member_id);
    enqueueTask(
      placement.node_name,
      "student.add",
      {
        lab: placement.lab_name,
        username: m.username,
        password,
        uid: m.linux_uid,
        gid: m.linux_uid,
      },
      actor,
    );
  }
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
  // Re-add every current member — see reprovisionPlacementMembers for why this is necessary.
  reprovisionPlacementMembers(fresh, actor);
  audit(actor, "placement.recreate", `${fresh.lab_name}@${fresh.node_name}`);
}

/** Retry a failed lab.create with the placement's authoritative settings. Agent handlers are
 * idempotent, so this safely converges a partially-created placement without allocating a new one. */
export function retryPlacement(placementId: number, actor?: string): void {
  const p = getPlacement(placementId);
  if (!p) throw new Error("Unknown placement");
  if (p.state !== "failed") throw new Error("Only a failed placement can be retried");
  db()
    .prepare("UPDATE lab_placements SET state = 'provisioning', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(Date.now(), placementId);
  enqueuePlacementCreate(p, actor);
  audit(actor, "placement.retry", `${p.lab_name}@${p.node_name}`);
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

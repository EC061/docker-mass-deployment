/**
 * Lab data access + orchestration. Creating/destroying a lab or changing its quota updates the
 * authoritative row and enqueues the corresponding task for the lab's node agent.
 */

import { db } from "./db";
import { enqueueTask } from "./queue";

// Lab names become ZFS dataset components and the docker container name on a root agent. Usernames
// are already strictly gated everywhere; close the asymmetry by allow-listing lab names too (M-04):
// a leading alphanumeric then alphanumerics/hyphen/underscore, no slashes/dots/whitespace, <= 40.
export const LAB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

export function isValidLabName(name: string): boolean {
  return LAB_NAME_RE.test(name);
}

export interface Lab {
  id: number;
  name: string;
  node_id: number;
  node_name: string;
  online: number;
  pi_email: string | null;
  fast_quota_bytes: number;
  slow_quota_bytes: number;
  image: string;
  ssh_port: number | null;
  container_options: string | null;
  status: string;
  created_at: number;
}

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

/** Parse a lab's stored container_options JSON, filling any missing keys with defaults. */
export function containerOptionsOf(lab: Pick<Lab, "container_options">): ContainerOptions {
  let parsed: Partial<ContainerOptions> = {};
  if (lab.container_options) {
    try {
      parsed = JSON.parse(lab.container_options) as Partial<ContainerOptions>;
    } catch {
      parsed = {};
    }
  }
  return { ...DEFAULT_CONTAINER_OPTIONS, ...parsed };
}

export function listLabs(): Lab[] {
  return db()
    .prepare(
      `SELECT labs.*, nodes.name AS node_name, nodes.online AS online
       FROM labs JOIN nodes ON nodes.id = labs.node_id
       ORDER BY labs.name`,
    )
    .all() as Lab[];
}

export function getLab(id: number): Lab | undefined {
  return db()
    .prepare(
      `SELECT labs.*, nodes.name AS node_name, nodes.online AS online
       FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE labs.id = ?`,
    )
    .get(id) as Lab | undefined;
}

export function getLabByName(name: string): Lab | undefined {
  return db()
    .prepare(
      `SELECT labs.*, nodes.name AS node_name, nodes.online AS online
       FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE labs.name = ?`,
    )
    .get(name) as Lab | undefined;
}

export interface CreateLabInput {
  name: string;
  nodeId: number;
  piEmail?: string;
  fastQuotaBytes: number;
  slowQuotaBytes: number;
  image: string;
  sshPort?: number;
  containerOptions?: Record<string, unknown>;
  actor?: string;
}

export function createLab(input: CreateLabInput): Lab {
  if (!isValidLabName(input.name)) {
    throw new Error("Invalid lab name (use letters, digits, hyphen or underscore; max 40 chars)");
  }
  const node = db().prepare("SELECT name FROM nodes WHERE id = ?").get(input.nodeId) as
    | { name: string }
    | undefined;
  if (!node) throw new Error("Unknown node");

  const now = Date.now();
  const info = db()
    .prepare(
      `INSERT INTO labs (name, node_id, pi_email, fast_quota_bytes, slow_quota_bytes, image, ssh_port, container_options, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
    )
    .run(
      input.name,
      input.nodeId,
      input.piEmail ?? null,
      input.fastQuotaBytes,
      input.slowQuotaBytes,
      input.image,
      input.sshPort ?? null,
      input.containerOptions ? JSON.stringify(input.containerOptions) : null,
      now,
    );

  enqueueTask(
    node.name,
    "lab.create",
    {
      lab: input.name,
      fast_quota_bytes: input.fastQuotaBytes,
      slow_quota_bytes: input.slowQuotaBytes,
      image: input.image,
      ssh_port: input.sshPort,
      container_options: input.containerOptions ?? {},
    },
    input.actor,
  );
  audit(input.actor, "lab.create", input.name, `node=${node.name}`);
  return getLab(Number(info.lastInsertRowid))!;
}

export function updateQuota(
  labId: number,
  fastQuotaBytes: number | undefined,
  slowQuotaBytes: number | undefined,
  actor?: string,
): void {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const params: Record<string, unknown> = { lab: lab.name };
  if (fastQuotaBytes !== undefined) {
    db().prepare("UPDATE labs SET fast_quota_bytes = ? WHERE id = ?").run(fastQuotaBytes, labId);
    params.fast_quota_bytes = fastQuotaBytes;
  }
  if (slowQuotaBytes !== undefined) {
    db().prepare("UPDATE labs SET slow_quota_bytes = ? WHERE id = ?").run(slowQuotaBytes, labId);
    params.slow_quota_bytes = slowQuotaBytes;
  }
  enqueueTask(lab.node_name, "lab.set_quota", params, actor);
  audit(actor, "lab.set_quota", lab.name, JSON.stringify(params));
}

export interface UpdateLabSettingsInput {
  piEmail?: string | null;
  image?: string;
  containerOptions?: Record<string, unknown>;
}

/**
 * Edit a lab's configuration after creation. PI email is metadata only. Changing the image or any
 * container option rewrites the stored config and recreates the container (data is preserved, same
 * path as the manual "recreate container" action). Returns true if a recreate was enqueued.
 */
export function updateLabSettings(labId: number, input: UpdateLabSettingsInput, actor?: string): boolean {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");

  if (input.piEmail !== undefined) {
    db().prepare("UPDATE labs SET pi_email = ? WHERE id = ?").run(input.piEmail || null, labId);
  }

  const prevOpts = db().prepare("SELECT container_options FROM labs WHERE id = ?").get(labId) as
    | { container_options: string | null }
    | undefined;
  const imageChanged = input.image !== undefined && input.image !== lab.image;
  const optsChanged =
    input.containerOptions !== undefined &&
    JSON.stringify(input.containerOptions) !== (prevOpts?.container_options ?? "null");

  if (input.image !== undefined) {
    db().prepare("UPDATE labs SET image = ? WHERE id = ?").run(input.image, labId);
  }
  if (input.containerOptions !== undefined) {
    db()
      .prepare("UPDATE labs SET container_options = ? WHERE id = ?")
      .run(JSON.stringify(input.containerOptions), labId);
  }

  audit(actor, "lab.update_settings", lab.name);

  if (imageChanged || optsChanged) {
    enqueueTask(
      lab.node_name,
      "container.recreate",
      {
        lab: lab.name,
        image: input.image ?? lab.image,
        ssh_port: lab.ssh_port,
        container_options: input.containerOptions ?? (prevOpts?.container_options ? JSON.parse(prevOpts.container_options) : {}),
      },
      actor,
    );
    return true;
  }
  return false;
}

/** Set a lab's textual status by name. Used by the result ingest path (provisioning -> active). */
export function markLabStatus(name: string, status: string): void {
  db().prepare("UPDATE labs SET status = ? WHERE name = ?").run(status, name);
}

export function destroyLab(labId: number, actor?: string): void {
  const lab = getLab(labId);
  if (!lab) return;
  // The node's lab.destroy tears down the container and every dataset (shared + all students), so
  // student *data* goes with the lab. Mark deleting, capture members for orphan cleanup, then enqueue.
  db().prepare("UPDATE labs SET status = 'deleting' WHERE id = ?").run(labId);
  const memberIds = (db()
    .prepare("SELECT student_id FROM lab_members WHERE lab_id = ?")
    .all(labId) as { student_id: number }[]).map((r) => r.student_id);

  enqueueTask(lab.node_name, "lab.destroy", { lab: lab.name }, actor);
  // Deleting the lab row cascades lab_members (ON DELETE CASCADE), removing every membership.
  db().prepare("DELETE FROM labs WHERE id = ?").run(labId);

  // Students belong to labs: drop any student that is now a member of no lab at all (a student kept
  // in another lab is left untouched). This is what "students are deleted on lab delete" means.
  let orphansRemoved = 0;
  for (const sid of memberIds) {
    const stillMember = db()
      .prepare("SELECT 1 FROM lab_members WHERE student_id = ? LIMIT 1")
      .get(sid);
    if (!stillMember) {
      db().prepare("DELETE FROM students WHERE id = ?").run(sid);
      orphansRemoved++;
    }
  }
  audit(actor, "lab.destroy", lab.name, orphansRemoved ? `${orphansRemoved} students removed` : undefined);
}

export function audit(actor: string | undefined, action: string, target?: string, detail?: string): void {
  db()
    .prepare("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), actor ?? null, action, target ?? null, detail ?? null);
}

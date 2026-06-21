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
  status: string;
  created_at: number;
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

export function destroyLab(labId: number, actor?: string): void {
  const lab = getLab(labId);
  if (!lab) return;
  enqueueTask(lab.node_name, "lab.destroy", { lab: lab.name }, actor);
  db().prepare("DELETE FROM labs WHERE id = ?").run(labId);
  audit(actor, "lab.destroy", lab.name);
}

export function audit(actor: string | undefined, action: string, target?: string, detail?: string): void {
  db()
    .prepare("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), actor ?? null, action, target ?? null, detail ?? null);
}

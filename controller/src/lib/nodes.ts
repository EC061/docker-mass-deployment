/**
 * Per-node identity for the agent hub.
 *
 * The hub used to trust one shared AGENT_TOKEN plus whatever node name the client claimed, so any
 * token holder could impersonate any node and drain its privileged task queue (C-04). Each node now
 * has its own token (bcrypt-hashed at rest) and must be on the allow-list. A node is provisioned in
 * the UI; first successful per-node auth pins the identity. The shared token still works for nodes
 * left in 'legacy' mode during rollout (gated by env.allowLegacyAgentToken).
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { safeEqual } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { env } from "./env";

export type ColdBackend = "local_zfs" | "smb";

// DNS-label-ish: lowercase alphanumeric + hyphen, 1-63 chars, must start alphanumeric. Rejects the
// literal "undefined", control chars, whitespace, and path/queue separators (M-03).
export const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidNodeName(name: string): boolean {
  return NODE_NAME_RE.test(name);
}

export interface NodeAuthResult {
  ok: boolean;
  reason?: string;
}

/** Generate a fresh node token (the plaintext is shown once and never stored). */
export function generateNodeToken(): string {
  return randomBytes(24).toString("hex");
}

interface NodeAuthRow {
  id: number;
  allowed: number;
  token_hash: string | null;
  auth_mode: string;
  token_pinned_at: number | null;
}

/**
 * Verify a hello frame's (name, token) against the node allow-list and credential. Synchronous so
 * it can run inline in the hub's message handler; uses bcrypt.compareSync.
 */
export function verifyNodeAuth(name: string, token: string): NodeAuthResult {
  if (!isValidNodeName(name)) return { ok: false, reason: "invalid node name" };
  if (!token) return { ok: false, reason: "missing token" };
  const row = db()
    .prepare("SELECT id, allowed, token_hash, auth_mode, token_pinned_at FROM nodes WHERE name = ?")
    .get(name) as NodeAuthRow | undefined;
  if (!row || row.allowed !== 1) return { ok: false, reason: "unknown or blocked node" };

  if (row.auth_mode === "pernode") {
    if (!row.token_hash || !bcrypt.compareSync(token, row.token_hash)) {
      return { ok: false, reason: "bad node token" };
    }
    if (row.token_pinned_at === null) {
      db().prepare("UPDATE nodes SET token_pinned_at = ? WHERE id = ?").run(Date.now(), row.id);
    }
    return { ok: true };
  }

  // Legacy: shared AGENT_TOKEN, only while the rollout flag permits it.
  if (!env.allowLegacyAgentToken) return { ok: false, reason: "legacy token disabled" };
  if (!safeEqual(token, env.agentToken)) return { ok: false, reason: "bad token" };
  return { ok: true };
}

/** Register (or pre-register) a node and issue it a token. Returns the one-time plaintext token. */
export function provisionNode(name: string, actor: string): string {
  if (!isValidNodeName(name)) throw new Error(`invalid node name '${name}'`);
  const token = generateNodeToken();
  const hash = bcrypt.hashSync(token, 10);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO nodes (name, allowed, token_hash, auth_mode, token_pinned_at, online, created_at)
       VALUES (?, 1, ?, 'pernode', NULL, 0, ?)
       ON CONFLICT(name) DO UPDATE SET
         allowed = 1, token_hash = excluded.token_hash, auth_mode = 'pernode', token_pinned_at = NULL`,
    )
    .run(name, hash, now);
  audit(actor, "node.provision", name);
  return token;
}

/** Rotate an existing node's token. Returns the new one-time plaintext token. */
export function rotateNodeToken(name: string, actor: string): string {
  const exists = db().prepare("SELECT 1 FROM nodes WHERE name = ?").get(name);
  if (!exists) throw new Error(`unknown node '${name}'`);
  return provisionNode(name, actor);
}

/**
 * Set (or clear) a node's human-friendly alias. The alias is cosmetic — the node `name` remains the
 * identity used for auth and task queueing. Pass an empty string to clear it.
 */
export function setNodeAlias(name: string, alias: string, actor: string): void {
  const exists = db().prepare("SELECT 1 FROM nodes WHERE name = ?").get(name);
  if (!exists) throw new Error(`unknown node '${name}'`);
  const clean = alias.trim().slice(0, 64) || null;
  db().prepare("UPDATE nodes SET alias = ? WHERE name = ?").run(clean, name);
  audit(actor, "node.alias", name, clean ?? "(cleared)");
}

/** Remove a node from the allow-list (its token stops working immediately). */
export function revokeNode(name: string, actor: string): void {
  db().prepare("UPDATE nodes SET allowed = 0 WHERE name = ?").run(name);
  audit(actor, "node.revoke", name);
}

/**
 * Permanently delete a node from the DB. Refuses while any lab placement still lives on it (its
 * storage is on that machine — remove the placements first). Also clears the node's queued tasks and
 * live GPU snapshot so a later same-named node starts clean; historical logs/events are kept.
 */
export function deleteNode(name: string, actor: string): void {
  const row = db().prepare("SELECT id FROM nodes WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`unknown node '${name}'`);
  const { n: placementCount } = db()
    .prepare("SELECT COUNT(*) AS n FROM lab_placements WHERE node_id = ?")
    .get(row.id) as { n: number };
  if (placementCount > 0) {
    throw new Error(
      `node '${name}' still hosts ${placementCount} lab placement(s); remove them before deleting the node`,
    );
  }
  // An SMB client node depends on this node as its cold-storage owner — block deletion.
  const dependents = db()
    .prepare("SELECT name FROM nodes WHERE cold_owner_node_id = ?")
    .all(row.id) as { name: string }[];
  if (dependents.length > 0) {
    throw new Error(
      `node '${name}' is the cold-storage owner for: ${dependents.map((d) => d.name).join(", ")}; reassign them first`,
    );
  }
  db().transaction(() => {
    db().prepare("DELETE FROM task_log WHERE node = ?").run(name);
    db().prepare("DELETE FROM gpu_snapshot WHERE node = ?").run(name);
    db().prepare("DELETE FROM nodes WHERE id = ?").run(row.id);
  })();
  audit(actor, "node.delete", name);
}

export interface NodeColdInfo {
  name: string;
  cold_backend: ColdBackend;
  cold_owner_node_id: number | null;
  owner_name: string | null;
  cold_mount_path: string | null;
  cold_ready: number;
}

/** Local-ZFS nodes — the only valid cold-storage owners for an SMB client. */
export function listLocalZfsNodes(): { id: number; name: string }[] {
  return db()
    .prepare("SELECT id, name FROM nodes WHERE cold_backend = 'local_zfs' ORDER BY name")
    .all() as { id: number; name: string }[];
}

/**
 * Configure a node's cold-storage backend. local_zfs: the node owns real ZFS cold storage. smb: cold
 * is replaced by a mount of an owner node's shared dataset (the owner must be a local-ZFS node).
 * Refuses while the node hosts any placement (changing the backend would orphan their storage), and
 * refuses to turn an owner node into an SMB client while other nodes still depend on it.
 */
export function setNodeColdStorage(
  name: string,
  backend: ColdBackend,
  ownerName: string | null,
  actor: string,
): void {
  if (backend !== "local_zfs" && backend !== "smb") throw new Error(`invalid cold backend '${backend}'`);
  const node = db().prepare("SELECT id FROM nodes WHERE name = ?").get(name) as { id: number } | undefined;
  if (!node) throw new Error(`unknown node '${name}'`);

  const { n: placementCount } = db()
    .prepare("SELECT COUNT(*) AS n FROM lab_placements WHERE node_id = ?")
    .get(node.id) as { n: number };
  if (placementCount > 0) {
    throw new Error(`node '${name}' hosts ${placementCount} placement(s); remove them before changing cold storage`);
  }

  let ownerId: number | null = null;
  if (backend === "smb") {
    if (!ownerName) throw new Error("an SMB node requires a cold-storage owner node");
    const owner = db()
      .prepare("SELECT id, cold_backend FROM nodes WHERE name = ?")
      .get(ownerName) as { id: number; cold_backend: string } | undefined;
    if (!owner) throw new Error(`unknown owner node '${ownerName}'`);
    if (owner.id === node.id) throw new Error("a node cannot be its own cold-storage owner");
    if (owner.cold_backend !== "local_zfs") throw new Error(`owner '${ownerName}' must use local ZFS cold storage`);
    ownerId = owner.id;
  } else {
    // Becoming local_zfs is fine even if others depend on us; but a node that IS an owner cannot turn
    // into an SMB client (handled above by the smb branch — only reachable when backend==='smb').
  }

  // Block turning an owner node into an SMB client while SMB clients still depend on it.
  if (backend === "smb") {
    const dependents = db().prepare("SELECT name FROM nodes WHERE cold_owner_node_id = ?").all(node.id) as { name: string }[];
    if (dependents.length > 0) {
      throw new Error(`node '${name}' is the cold owner for ${dependents.map((d) => d.name).join(", ")}; reassign them first`);
    }
  }

  db()
    .prepare("UPDATE nodes SET cold_backend = ?, cold_owner_node_id = ? WHERE id = ?")
    .run(backend, ownerId, node.id);
  audit(actor, "node.cold_storage", name, ownerName ? `${backend} owner=${ownerName}` : backend);
}

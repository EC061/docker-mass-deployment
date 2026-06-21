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
import { db } from "./db";
import { env } from "./env";

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
  if (token !== env.agentToken) return { ok: false, reason: "bad token" };
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

/** Remove a node from the allow-list (its token stops working immediately). */
export function revokeNode(name: string, actor: string): void {
  db().prepare("UPDATE nodes SET allowed = 0 WHERE name = ?").run(name);
  audit(actor, "node.revoke", name);
}

function audit(actor: string, action: string, target: string): void {
  db()
    .prepare("INSERT INTO audit_log (ts, actor, action, target) VALUES (?, ?, ?, ?)")
    .run(Date.now(), actor, action, target);
}

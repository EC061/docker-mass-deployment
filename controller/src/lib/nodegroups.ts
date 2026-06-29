/**
 * User-defined named groupings of nodes (migration 0016). Purely organisational — a group has no
 * bearing on auth, placement, or cold-storage topology; it only rolls up per-node usage on the Stats
 * page. Membership is many-to-many: a node may belong to several groups, and a node in no group is
 * shown under "Ungrouped".
 */

import { audit } from "./audit";
import { db } from "./db";

export interface NodeGroup {
  id: number;
  name: string;
  created_at: number;
  nodeIds: number[];
}

const MAX_NAME_LEN = 40;

/** Trim and validate a group name (1..40 chars, must not be blank). Returns the cleaned name. */
function cleanGroupName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Group name is required");
  if (clean.length > MAX_NAME_LEN) throw new Error(`Group name must be at most ${MAX_NAME_LEN} characters`);
  return clean;
}

/** All groups with their member node ids, ordered by name. */
export function listNodeGroups(): NodeGroup[] {
  const groups = db()
    .prepare("SELECT id, name, created_at FROM node_groups ORDER BY name")
    .all() as { id: number; name: string; created_at: number }[];
  const members = db()
    .prepare("SELECT group_id, node_id FROM node_group_members")
    .all() as { group_id: number; node_id: number }[];
  const byGroup = new Map<number, number[]>();
  for (const m of members) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push(m.node_id);
    byGroup.set(m.group_id, list);
  }
  return groups.map((g) => ({ ...g, nodeIds: byGroup.get(g.id) ?? [] }));
}

export function createNodeGroup(name: string, actor?: string): NodeGroup {
  const clean = cleanGroupName(name);
  const existing = db().prepare("SELECT 1 FROM node_groups WHERE name = ?").get(clean);
  if (existing) throw new Error(`A group named '${clean}' already exists`);
  const info = db()
    .prepare("INSERT INTO node_groups (name, created_at) VALUES (?, ?)")
    .run(clean, Date.now());
  audit(actor, "nodegroup.create", clean);
  return { id: Number(info.lastInsertRowid), name: clean, created_at: Date.now(), nodeIds: [] };
}

export function renameNodeGroup(id: number, name: string, actor?: string): void {
  const clean = cleanGroupName(name);
  const group = db().prepare("SELECT name FROM node_groups WHERE id = ?").get(id) as { name: string } | undefined;
  if (!group) throw new Error("Unknown group");
  const clash = db().prepare("SELECT 1 FROM node_groups WHERE name = ? AND id <> ?").get(clean, id);
  if (clash) throw new Error(`A group named '${clean}' already exists`);
  db().prepare("UPDATE node_groups SET name = ? WHERE id = ?").run(clean, id);
  audit(actor, "nodegroup.rename", group.name, clean);
}

export function deleteNodeGroup(id: number, actor?: string): void {
  const group = db().prepare("SELECT name FROM node_groups WHERE id = ?").get(id) as { name: string } | undefined;
  if (!group) return;
  db().prepare("DELETE FROM node_groups WHERE id = ?").run(id); // cascades node_group_members
  audit(actor, "nodegroup.delete", group.name);
}

/** Replace a group's membership with exactly `nodeIds` (unknown node ids are ignored). */
export function setNodeGroupMembers(id: number, nodeIds: number[], actor?: string): void {
  const group = db().prepare("SELECT name FROM node_groups WHERE id = ?").get(id) as { name: string } | undefined;
  if (!group) throw new Error("Unknown group");
  const valid = new Set(
    (db().prepare("SELECT id FROM nodes").all() as { id: number }[]).map((n) => n.id),
  );
  const wanted = [...new Set(nodeIds)].filter((n) => valid.has(n));
  db().transaction(() => {
    db().prepare("DELETE FROM node_group_members WHERE group_id = ?").run(id);
    const ins = db().prepare("INSERT INTO node_group_members (group_id, node_id) VALUES (?, ?)");
    for (const nodeId of wanted) ins.run(id, nodeId);
  })();
  audit(actor, "nodegroup.members", group.name, `${wanted.length} node(s)`);
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-nodegroups-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");
let stats: typeof import("../src/lib/stats");
let groups: typeof import("../src/lib/nodegroups");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  stats = await import("../src/lib/stats");
  groups = await import("../src/lib/nodegroups");
  const d = dbmod.db();
  // node-a: normal (local_zfs) owner; node-smb: SMB client of node-a; node-empty: normal, no placements.
  d.prepare("INSERT INTO nodes (id, name, online, cold_backend, created_at) VALUES (1, 'node-a', 1, 'local_zfs', 0)").run();
  d.prepare("INSERT INTO nodes (id, name, online, cold_backend, cold_owner_node_id, created_at) VALUES (2, 'node-smb', 1, 'smb', 1, 0)").run();
  d.prepare("INSERT INTO nodes (id, name, online, cold_backend, created_at) VALUES (3, 'node-empty', 0, 'local_zfs', 0)").run();

  d.prepare("INSERT INTO labs (id, name, created_at, updated_at) VALUES (1, 'bio', 0, 0)").run();
  // placement 1 on node-a, placement 2 on node-smb (same lab spread across two nodes).
  d.prepare(
    `INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
     VALUES (1, 1, 1, 2000, 3000, 50001, 'img', 'active', 0, 0)`,
  ).run();
  d.prepare(
    `INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
     VALUES (2, 1, 2, 1000, NULL, 50002, 'img', 'active', 0, 0)`,
  ).run();

  const sample = (pid: number, pool: string, used: number, quota: number | null) =>
    d.prepare(
      "INSERT INTO storage_samples (placement_id, student_id, pool, used_bytes, quota_bytes, ts) VALUES (?, NULL, ?, ?, ?, 100)",
    ).run(pid, pool, used, quota);
  sample(1, "fast", 500, 2000);
  sample(1, "slow", 200, 3000);
  sample(2, "fast", 300, 1000);
  sample(2, "slow", 999, null); // SMB cold — must be ignored (counted on the owner instead)
});

describe("buildNodeUsage", () => {
  it("sums fast + cold for a normal node and fast-only for an SMB node", () => {
    const usage = stats.buildNodeUsage();
    const a = usage.find((n) => n.name === "node-a")!;
    expect(a.coldBackend).toBe("local_zfs");
    expect(a.fastUsed).toBe(500);
    expect(a.coldUsed).toBe(200);
    expect(a.coldOwnerName).toBeNull();

    const smb = usage.find((n) => n.name === "node-smb")!;
    expect(smb.coldBackend).toBe("smb");
    expect(smb.fastUsed).toBe(300);
    expect(smb.coldUsed).toBeNull(); // fast only — cold is counted on the owner
    expect(smb.coldOwnerName).toBe("node-a");
  });

  it("lists nodes with no placements with null totals", () => {
    const empty = stats.buildNodeUsage().find((n) => n.name === "node-empty")!;
    expect(empty.fastUsed).toBeNull();
    expect(empty.coldUsed).toBeNull();
  });
});

describe("node groups", () => {
  it("creates, lists, sets members, renames, and deletes a group", () => {
    const g = groups.createNodeGroup("Cluster One", "admin@x.edu");
    expect(g.name).toBe("Cluster One");

    groups.setNodeGroupMembers(g.id, [1, 2, 99999], "admin@x.edu"); // unknown node id is ignored
    const listed = groups.listNodeGroups().find((x) => x.id === g.id)!;
    expect(listed.nodeIds.sort()).toEqual([1, 2]);

    groups.renameNodeGroup(g.id, "Cluster A", "admin@x.edu");
    expect(groups.listNodeGroups().find((x) => x.id === g.id)!.name).toBe("Cluster A");

    groups.deleteNodeGroup(g.id, "admin@x.edu");
    expect(groups.listNodeGroups().find((x) => x.id === g.id)).toBeUndefined();
    // membership rows are gone (cascade).
    const orphan = (dbmod.db().prepare("SELECT COUNT(*) AS n FROM node_group_members WHERE group_id = ?").get(g.id) as { n: number }).n;
    expect(orphan).toBe(0);
  });

  it("rejects blank and duplicate names", () => {
    const a = groups.createNodeGroup("dupe");
    expect(() => groups.createNodeGroup("dupe")).toThrow(/already exists/);
    expect(() => groups.createNodeGroup("   ")).toThrow(/required/);
    const b = groups.createNodeGroup("other");
    expect(() => groups.renameNodeGroup(b.id, "dupe")).toThrow(/already exists/);
    groups.deleteNodeGroup(a.id);
    groups.deleteNodeGroup(b.id);
  });
});

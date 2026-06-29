import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-nodes-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "shared-agent-token";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let nodes: typeof import("../src/lib/nodes");
let dbmod: typeof import("../src/lib/db");

beforeAll(async () => {
  nodes = await import("../src/lib/nodes");
  dbmod = await import("../src/lib/db");
});

describe("node name validation (M-03)", () => {
  it("accepts dns-label-ish names and rejects junk", () => {
    expect(nodes.isValidNodeName("gpu-01")).toBe(true);
    expect(nodes.isValidNodeName("a")).toBe(true);
    expect(nodes.isValidNodeName("undefined")).toBe(true); // a literal valid name, distinct from missing
    expect(nodes.isValidNodeName("")).toBe(false);
    expect(nodes.isValidNodeName("-bad")).toBe(false);
    expect(nodes.isValidNodeName("UPPER")).toBe(false);
    expect(nodes.isValidNodeName("gpu 1")).toBe(false);
    expect(nodes.isValidNodeName("gpu\n1")).toBe(false);
    expect(nodes.isValidNodeName("a".repeat(64))).toBe(false);
  });
});

describe("verifyNodeAuth (C-04)", () => {
  it("rejects an unknown / not-allow-listed node", () => {
    expect(nodes.verifyNodeAuth("ghost", "anything").ok).toBe(false);
  });

  it("accepts the correct per-node token, rejects a wrong one, and pins first-seen", () => {
    const token = nodes.provisionNode("gpu-a", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-a", "wrong").ok).toBe(false);

    const before = dbmod.db().prepare("SELECT token_pinned_at FROM nodes WHERE name = ?").get("gpu-a") as any;
    expect(before.token_pinned_at).toBeNull();

    expect(nodes.verifyNodeAuth("gpu-a", token).ok).toBe(true);
    const after = dbmod.db().prepare("SELECT token_pinned_at FROM nodes WHERE name = ?").get("gpu-a") as any;
    expect(typeof after.token_pinned_at).toBe("number");
  });

  it("does not accept the shared token for a per-node node", () => {
    nodes.provisionNode("gpu-b", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-b", "shared-agent-token").ok).toBe(false);
  });

  it("accepts the shared token only for an allow-listed legacy node", () => {
    // Simulate a node backfilled by migration 0004 (allowed=1, auth_mode='legacy').
    dbmod
      .db()
      .prepare(
        "INSERT INTO nodes (name, allowed, auth_mode, online, created_at) VALUES (?, 1, 'legacy', 0, ?)",
      )
      .run("legacy-node", Date.now());
    expect(nodes.verifyNodeAuth("legacy-node", "shared-agent-token").ok).toBe(true);
    expect(nodes.verifyNodeAuth("legacy-node", "nope").ok).toBe(false);
  });

  it("revoke removes a node from the allow-list", () => {
    const token = nodes.provisionNode("gpu-c", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-c", token).ok).toBe(true);
    nodes.revokeNode("gpu-c", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-c", token).ok).toBe(false);
  });
});

describe("deleteNode", () => {
  it("permanently removes the node row and its token stops working", () => {
    const token = nodes.provisionNode("gpu-del", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-del", token).ok).toBe(true);
    nodes.deleteNode("gpu-del", "admin@uga.edu");
    const row = dbmod.db().prepare("SELECT 1 FROM nodes WHERE name = ?").get("gpu-del");
    expect(row).toBeUndefined();
    // Auth fails because the node is no longer on the allow-list at all.
    expect(nodes.verifyNodeAuth("gpu-del", token).ok).toBe(false);
  });

  it("throws on an unknown node", () => {
    expect(() => nodes.deleteNode("does-not-exist", "admin@uga.edu")).toThrow(/unknown node/);
  });

  it("refuses to delete a node that still hosts a lab placement", () => {
    nodes.provisionNode("gpu-haslabs", "admin@uga.edu");
    const id = (
      dbmod.db().prepare("SELECT id FROM nodes WHERE name = ?").get("gpu-haslabs") as { id: number }
    ).id;
    const now = Date.now();
    dbmod.db().prepare("INSERT INTO labs (name, created_at, updated_at) VALUES ('lab-x', ?, ?)").run(now, now);
    const labId = (dbmod.db().prepare("SELECT id FROM labs WHERE name='lab-x'").get() as { id: number }).id;
    dbmod
      .db()
      .prepare(
        `INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
         VALUES (?, ?, 0, 0, 40000, 'custom-ssh', 'active', ?, ?)`,
      )
      .run(labId, id, now, now);
    expect(() => nodes.deleteNode("gpu-haslabs", "admin@uga.edu")).toThrow(/still hosts 1 lab placement/);
    // The node row is left intact when deletion is refused.
    expect(dbmod.db().prepare("SELECT 1 FROM nodes WHERE name = ?").get("gpu-haslabs")).toBeDefined();
  });
});

describe("cold storage (Phase 3)", () => {
  it("defaults nodes to local_zfs and lists them as owner candidates", () => {
    nodes.provisionNode("cold-owner", "a@x.edu");
    nodes.provisionNode("cold-client", "a@x.edu");
    const owners = nodes.listLocalZfsNodes().map((n) => n.name);
    expect(owners).toEqual(expect.arrayContaining(["cold-owner", "cold-client"]));
  });

  it("configures an SMB client pointing at a local-ZFS owner", () => {
    nodes.setNodeColdStorage("cold-client", "smb", "cold-owner", "a@x.edu");
    const row = dbmod.db().prepare("SELECT cold_backend, cold_owner_node_id FROM nodes WHERE name='cold-client'").get() as any;
    expect(row.cold_backend).toBe("smb");
    expect(row.cold_owner_node_id).toBeTruthy();
    // an SMB client is no longer a valid owner candidate.
    expect(nodes.listLocalZfsNodes().map((n) => n.name)).not.toContain("cold-client");
  });

  it("rejects SMB with no owner / a non-local-ZFS owner / self as owner", () => {
    nodes.provisionNode("c2", "a@x.edu");
    expect(() => nodes.setNodeColdStorage("c2", "smb", null, "a@x.edu")).toThrow(/requires a cold-storage owner/);
    expect(() => nodes.setNodeColdStorage("c2", "smb", "cold-client", "a@x.edu")).toThrow(/must use local ZFS/);
    expect(() => nodes.setNodeColdStorage("c2", "smb", "c2", "a@x.edu")).toThrow(/cannot be its own/);
  });

  it("refuses to change cold storage while the node hosts a placement", () => {
    nodes.provisionNode("busy-cold", "a@x.edu");
    const nid = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='busy-cold'").get() as any).id;
    dbmod.db().prepare("INSERT INTO labs (name, created_at, updated_at) VALUES ('cl', 0, 0)").run();
    const lid = (dbmod.db().prepare("SELECT id FROM labs WHERE name='cl'").get() as any).id;
    dbmod.db()
      .prepare("INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at) VALUES (?, ?, 1, 1, 41000, 'i', 'active', 0, 0)")
      .run(lid, nid);
    expect(() => nodes.setNodeColdStorage("busy-cold", "smb", "cold-owner", "a@x.edu")).toThrow(/placement/);
  });

  it("blocks deleting an owner node while SMB clients depend on it", () => {
    // cold-client depends on cold-owner from the test above.
    expect(() => nodes.deleteNode("cold-owner", "a@x.edu")).toThrow(/cold-storage owner/);
  });
});

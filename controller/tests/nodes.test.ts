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

describe("verifyNodeAuth (C-04, per-node HMAC)", () => {
  it("rejects an unknown / not-allow-listed node", () => {
    expect(nodes.verifyNodeAuth("ghost", "anything").ok).toBe(false);
  });

  it("accepts the correct per-node token and rejects a wrong one", () => {
    const token = nodes.provisionNode("gpu-a", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-a", "wrong").ok).toBe(false);
    const res = nodes.verifyNodeAuth("gpu-a", token);
    expect(res.ok).toBe(true);
    // The stored hash is the HMAC hex (not the plaintext, not a bcrypt string) and is returned so
    // the hub can detect a later rotation on a live socket.
    const stored = (dbmod.db().prepare("SELECT token_hash AS h FROM nodes WHERE name=?").get("gpu-a") as any).h;
    expect(stored).toBe(nodes.nodeTokenHash("gpu-a", token));
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(res.tokenHash).toBe(stored);
  });

  it("never accepts the shared AGENT_TOKEN — there is no legacy fallback", () => {
    nodes.provisionNode("gpu-b", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-b", "shared-agent-token").ok).toBe(false);
  });

  it("binds the token to the node name (a token minted for A does not work as B)", () => {
    const tokenA = nodes.provisionNode("node-a", "admin@uga.edu");
    nodes.provisionNode("node-b", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("node-a", tokenA).ok).toBe(true);
    expect(nodes.verifyNodeAuth("node-b", tokenA).ok).toBe(false);
  });

  it("revoke removes a node from the allow-list", () => {
    const token = nodes.provisionNode("gpu-c", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-c", token).ok).toBe(true);
    nodes.revokeNode("gpu-c", "admin@uga.edu");
    expect(nodes.verifyNodeAuth("gpu-c", token).ok).toBe(false);
  });
});

describe("nodeStillAuthorized (live-socket revoke/rotation poll)", () => {
  it("is true while allowed + hash unchanged, false after revoke or rotation", () => {
    const token = nodes.provisionNode("live-a", "admin@uga.edu");
    const hash = nodes.nodeTokenHash("live-a", token);
    expect(nodes.nodeStillAuthorized("live-a", hash)).toBe(true);
    // Rotation changes the stored hash -> the old socket's hash no longer matches.
    nodes.rotateNodeToken("live-a", "admin@uga.edu");
    expect(nodes.nodeStillAuthorized("live-a", hash)).toBe(false);
    // Revocation drops authorization regardless of hash.
    const newHash = (dbmod.db().prepare("SELECT token_hash AS h FROM nodes WHERE name=?").get("live-a") as any).h;
    expect(nodes.nodeStillAuthorized("live-a", newHash)).toBe(true);
    nodes.revokeNode("live-a", "admin@uga.edu");
    expect(nodes.nodeStillAuthorized("live-a", newHash)).toBe(false);
  });

  it("is false for an unknown node", () => {
    expect(nodes.nodeStillAuthorized("nobody", "deadbeef")).toBe(false);
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

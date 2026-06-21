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

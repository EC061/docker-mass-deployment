import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-placements-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const enqueueTask = vi.fn((..._args: unknown[]) => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));
const sendCredentialEmail = vi.fn(async () => ({ sent: true }));
const sendRemovalEmail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendCredentialEmail, sendRemovalEmail }));

let dbmod: typeof import("../src/lib/db");
let labs: typeof import("../src/lib/labs");
let placements: typeof import("../src/lib/placements");
let students: typeof import("../src/lib/students");
let nodeA: number;
let nodeB: number;

const OPTS = { cpus: "4", memory: "8g", shm_size: "1g", rootfs_quota: "300g", restart: "unless-stopped" };

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  labs = await import("../src/lib/labs");
  placements = await import("../src/lib/placements");
  students = await import("../src/lib/students");
  const db = dbmod.db();
  db.prepare("INSERT INTO nodes (name, online, created_at) VALUES ('node-a', 1, 0)").run();
  db.prepare("INSERT INTO nodes (name, online, created_at) VALUES ('node-b', 1, 0)").run();
  nodeA = (db.prepare("SELECT id FROM nodes WHERE name='node-a'").get() as any).id;
  nodeB = (db.prepare("SELECT id FROM nodes WHERE name='node-b'").get() as any).id;
  // Default SSH port range for nextSshPortForNode.
  const settings = await import("../src/lib/settings");
  settings.setSetting("sshPortStart", 50000);
  settings.setSetting("sshPortEnd", 50100);
});

beforeEach(() => {
  enqueueTask.mockClear();
  sendCredentialEmail.mockClear();
  sendRemovalEmail.mockClear();
});

const newLab = (name: string) => labs.createLab({ name, actor: "admin" });
const grant = (labId: number, nodeId: number, extra: Record<string, unknown> = {}) =>
  placements.createPlacement({
    labId,
    nodeId,
    fastQuotaBytes: 1000,
    coldQuotaBytes: 2000,
    sshPort: placements.nextSshPortForNode(nodeId),
    image: "custom-ssh",
    containerOptions: OPTS,
    actor: "admin",
    ...extra,
  });

describe("createPlacement", () => {
  it("inserts a provisioning placement and enqueues lab.create with the node-specific config", async () => {
    const lab = newLab("bio");
    const p = await grant(lab.id, nodeA);
    expect(p.state).toBe("provisioning");
    expect(p.node_name).toBe("node-a");
    expect(enqueueTask).toHaveBeenCalledWith(
      "node-a",
      "lab.create",
      expect.objectContaining({ lab: "bio", fast_quota_bytes: 1000, slow_quota_bytes: 2000, image: "custom-ssh" }),
      "admin",
    );
    expect(dbmod.db().prepare("SELECT 1 FROM audit_log WHERE action='placement.create' AND target='bio@node-a'").get()).toBeTruthy();
  });

  it("runs one logical lab on multiple nodes with independent per-node SSH ports", async () => {
    const lab = newLab("multi");
    const pa = await grant(lab.id, nodeA);
    const pb = await grant(lab.id, nodeB);
    expect(placements.listPlacements(lab.id).map((p) => p.node_name).sort()).toEqual(["node-a", "node-b"]);
    // Ports are allocated per node: node-b's first placement gets the range start (50000),
    // independent of how many ports node-a has already consumed.
    expect(pb.ssh_port).toBe(50000);
    expect(pa.ssh_port).toBeGreaterThan(pb.ssh_port);
    expect(placements.placementExists(lab.id, nodeA)).toBe(true);
  });

  it("provisions the lab's existing roster onto a new placement (one student.add each)", async () => {
    const lab = newLab("withroster");
    await students.addStudentToLab(lab.id, { username: "alice", email: "a@uga.edu" }, "admin");
    await students.addStudentToLab(lab.id, { username: "bob" }, "admin"); // no placement yet -> roster only
    enqueueTask.mockClear();

    const p = await grant(lab.id, nodeA);
    const adds = enqueueTask.mock.calls.filter((c) => c[1] === "student.add");
    expect(adds.map((c) => (c[2] as any).username).sort()).toEqual(["alice", "bob"]);
    expect(adds.every((c) => Number.isInteger((c[2] as any).uid) &&
      (c[2] as any).uid === (c[2] as any).gid)).toBe(true);
    // placement_members recorded for both.
    const n = (dbmod.db().prepare("SELECT COUNT(*) AS n FROM placement_members WHERE placement_id=?").get(p.id) as any).n;
    expect(n).toBe(2);
  });
});

describe("nextSshPortForNode", () => {
  it("allocates the lowest free port per node and throws when exhausted", async () => {
    const settings = await import("../src/lib/settings");
    const lab = newLab("ports");
    // node-a already has placements from earlier tests; this lab adds one more.
    const p = await grant(lab.id, nodeA);
    expect(p.ssh_port).toBeGreaterThanOrEqual(50000);

    settings.setSetting("sshPortStart", 60000);
    settings.setSetting("sshPortEnd", 60000);
    // Occupy 60000 on node-b.
    const lab2 = newLab("ports2");
    await placements.createPlacement({ labId: lab2.id, nodeId: nodeB, fastQuotaBytes: 1, coldQuotaBytes: 1, sshPort: 60000, image: "i", containerOptions: OPTS });
    expect(() => placements.nextSshPortForNode(nodeB)).toThrow(/No free SSH port/);
    settings.setSetting("sshPortStart", 50000);
    settings.setSetting("sshPortEnd", 50100);
  });
});

describe("updatePlacementQuota (live, no recreate)", () => {
  it("updates fast/cold and enqueues lab.set_quota without container.recreate", async () => {
    const lab = newLab("quota");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();
    placements.updatePlacementQuota(p.id, { fastQuotaBytes: 5000, coldQuotaBytes: 6000 }, "admin");
    const fresh = placements.getPlacement(p.id)!;
    expect(fresh.fast_quota_bytes).toBe(5000);
    expect(fresh.cold_quota_bytes).toBe(6000);
    expect(enqueueTask).toHaveBeenCalledWith(
      "node-a",
      "lab.set_quota",
      expect.objectContaining({ lab: "quota", fast_quota_bytes: 5000, slow_quota_bytes: 6000 }),
      "admin",
    );
    expect(enqueueTask.mock.calls.some((c) => c[1] === "container.recreate")).toBe(false);
  });
});

describe("retryPlacement", () => {
  it("requeues a failed placement with its authoritative settings", async () => {
    const lab = newLab("retry-placement");
    const p = await grant(lab.id, nodeA);
    placements.markPlacementState(p.id, "failed", "temporary create failure");
    enqueueTask.mockClear();

    placements.retryPlacement(p.id, "admin");

    const fresh = placements.getPlacement(p.id)!;
    expect(fresh.state).toBe("provisioning");
    expect(fresh.last_error).toBeNull();
    expect(enqueueTask).toHaveBeenCalledWith(
      "node-a",
      "lab.create",
      expect.objectContaining({
        lab: "retry-placement",
        fast_quota_bytes: p.fast_quota_bytes,
        slow_quota_bytes: p.cold_quota_bytes,
        image: p.image,
        ssh_port: p.ssh_port,
      }),
      "admin",
    );
    expect(() => placements.retryPlacement(p.id, "admin")).toThrow(/Only a failed placement/);
  });
});

describe("recreatePlacement", () => {
  it("enqueues container.recreate with the placement's config", async () => {
    const lab = newLab("recreate");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();
    placements.recreatePlacement(p.id, { image: "custom-ssh-v2" }, "admin");
    expect(placements.getPlacement(p.id)!.image).toBe("custom-ssh-v2");
    expect(enqueueTask).toHaveBeenCalledWith(
      "node-a",
      "container.recreate",
      expect.objectContaining({ lab: "recreate", image: "custom-ssh-v2" }),
      "admin",
    );
  });
});

describe("SMB placement rules + shared student removal", () => {
  let ownerId: number;
  let clientId: number;

  beforeAll(() => {
    const d = dbmod.db();
    d.prepare("INSERT INTO nodes (name, online, created_at, cold_backend, cold_ready) VALUES ('own-1', 1, 0, 'local_zfs', 1)").run();
    ownerId = (d.prepare("SELECT id FROM nodes WHERE name='own-1'").get() as any).id;
    d.prepare("INSERT INTO nodes (name, online, created_at, cold_backend, cold_owner_node_id, cold_ready) VALUES ('smb-1', 1, 0, 'smb', ?, 1)").run(ownerId);
    clientId = (d.prepare("SELECT id FROM nodes WHERE name='smb-1'").get() as any).id;
  });

  it("refuses an SMB client until the owner hosts the lab actively, then allows it with no cold quota", async () => {
    const lab = newLab("smblab");
    // No owner placement yet -> refuse.
    await expect(grant(lab.id, clientId)).rejects.toThrow(/grant the cold-storage owner 'own-1'/);

    const owner = await grant(lab.id, ownerId);
    // Owner still provisioning -> refuse.
    await expect(grant(lab.id, clientId)).rejects.toThrow(/wait until it is active/);

    placements.markPlacementState(owner.id, "active");
    const client = await grant(lab.id, clientId);
    expect(client.cold_quota_bytes).toBeNull(); // owner-managed cold, no local quota
    expect(client.node_cold_backend).toBe("smb");
  });

  it("refuses an SMB client whose mount is not active", async () => {
    const lab = newLab("smblab2");
    const owner = await grant(lab.id, ownerId);
    placements.markPlacementState(owner.id, "active");
    dbmod.db().prepare("UPDATE nodes SET cold_ready = 0 WHERE id = ?").run(clientId);
    await expect(grant(lab.id, clientId)).rejects.toThrow(/mount on 'smb-1' is not an active mount/);
    dbmod.db().prepare("UPDATE nodes SET cold_ready = 1 WHERE id = ?").run(clientId);
  });

  it("deletes shared cold only on the owner (delete_cold=false on the SMB client)", async () => {
    const lab = newLab("smblab3");
    const owner = await grant(lab.id, ownerId);
    placements.markPlacementState(owner.id, "active");
    await students.addStudentToLab(lab.id, { username: "alice", email: "a@x.edu" }, "admin");
    const client = await grant(lab.id, clientId);
    placements.markPlacementState(client.id, "active");

    const alice = students.listMembers(lab.id).find((m) => m.username === "alice")!;
    enqueueTask.mockClear();
    students.removeStudentFromLab(lab.id, alice.id, true, "admin");

    const removes = enqueueTask.mock.calls.filter((c) => c[1] === "student.remove");
    const byNode = Object.fromEntries(removes.map((c) => [c[0], c[2]]));
    expect(byNode["own-1"]).toMatchObject({ delete_data: true, delete_cold: true });
    expect(byNode["smb-1"]).toMatchObject({ delete_data: true, delete_cold: false });
  });

  it("blocks tearing down the owner placement while an SMB client depends on it", async () => {
    const lab = newLab("smblab4");
    const owner = await grant(lab.id, ownerId);
    placements.markPlacementState(owner.id, "active");
    const client = await grant(lab.id, clientId);
    expect(() => placements.destroyPlacement(owner.id, "admin")).toThrow(/owns the shared cold storage/);
    // Removing the client first unblocks the owner.
    placements.destroyPlacement(client.id, "admin");
    placements.confirmPlacementDestroyed("smblab4", "smb-1");
    expect(() => placements.destroyPlacement(owner.id, "admin")).not.toThrow();
  });
});

describe("container config validation", () => {
  it("accepts valid config and rejects bad image / resources", () => {
    expect(() => placements.validateContainerConfig("custom-ssh", OPTS)).not.toThrow();
    expect(() => placements.validateContainerConfig("ghcr.io/org/img:1.2@sha256:" + "a".repeat(64), OPTS)).not.toThrow();
    expect(() => placements.validateContainerConfig("-bad", OPTS)).toThrow(/Invalid image/);
    expect(() => placements.validateContainerConfig("ok", { ...OPTS, cpus: "lots" })).toThrow(/CPUs/);
    expect(() => placements.validateContainerConfig("ok", { ...OPTS, memory: "8gigs" })).toThrow(/memory/);
    expect(() => placements.validateContainerConfig("ok", { ...OPTS, restart: "sometimes" })).toThrow(/Restart/);
  });

  it("recreatePlacement rejects an invalid image before queueing anything", async () => {
    const lab = newLab("recval");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();
    expect(() => placements.recreatePlacement(p.id, { image: "-bad" })).toThrow(/Invalid image/);
    expect(enqueueTask.mock.calls.some((c) => c[1] === "container.recreate")).toBe(false);
    // the stored image is unchanged.
    expect(placements.getPlacement(p.id)!.image).toBe("custom-ssh");
  });
});

describe("destroyPlacement keeps the row until the agent confirms", () => {
  it("marks deleting + enqueues lab.destroy; confirm removes the row", async () => {
    const lab = newLab("teardown");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();
    placements.destroyPlacement(p.id, "admin");
    expect(placements.getPlacement(p.id)!.state).toBe("deleting");
    expect(enqueueTask).toHaveBeenCalledWith("node-a", "lab.destroy", { lab: "teardown" }, "admin");
    placements.confirmPlacementDestroyed("teardown", "node-a");
    expect(placements.getPlacement(p.id)).toBeUndefined();
  });
});

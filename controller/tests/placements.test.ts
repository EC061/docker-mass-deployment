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

/** A node with reported pool telemetry, so the capacity/commitment checks have something to read. */
const addNodeWithPools = (name: string, fastSize: number, coldSize: number) => {
  const db = dbmod.db();
  db.prepare("INSERT INTO nodes (name, online, created_at, pools) VALUES (?, 1, 0, ?)").run(
    name,
    JSON.stringify([
      { name: `${name}-fast`, size: fastSize, alloc: 0, free: fastSize, tiers: ["fast"] },
      { name: `${name}-cold`, size: coldSize, alloc: 0, free: coldSize, tiers: ["cold"] },
    ]),
  );
  return (db.prepare("SELECT id FROM nodes WHERE name = ?").get(name) as any).id as number;
};

const memberRow = (placementId: number, username: string) =>
  dbmod.db()
    .prepare(
      `SELECT pm.state, pm.last_error, pm.credential_secret FROM placement_members pm
       JOIN students ON students.id = pm.student_id
       WHERE pm.placement_id = ? AND students.username = ?`,
    )
    .get(placementId, username) as { state: string; last_error: string | null; credential_secret: string | null };

const setMemberState = (placementId: number, username: string, state: string, error: string | null = null) =>
  dbmod.db()
    .prepare(
      `UPDATE placement_members SET state = ?, last_error = ?
       WHERE placement_id = ? AND student_id = (SELECT id FROM students WHERE username = ?)`,
    )
    .run(state, error, placementId, username);

describe("createPlacement", () => {
  it("keeps student quota mode disabled unless explicitly supplied", async () => {
    const lab = newLab("no-student-quota");
    const p = await grant(lab.id, nodeA);
    expect(p.student_fast_quota_bytes).toBeNull();
    expect(p.student_cold_quota_bytes).toBeNull();
  });

  it("supports fast-only per-student quota and includes it in student provisioning", async () => {
    const lab = newLab("student-fast-only");
    await students.addStudentToLab(lab.id, { username: "fastonly" }, "admin");
    enqueueTask.mockClear();
    const p = await grant(lab.id, nodeA, { studentFastQuotaBytes: 500, studentColdQuotaBytes: null });
    expect(p.student_fast_quota_bytes).toBe(500);
    expect(p.student_cold_quota_bytes).toBeNull();
    const add = enqueueTask.mock.calls.find((c) => c[1] === "student.add")!;
    expect(add[2]).toEqual(expect.objectContaining({
      username: "fastonly", student_fast_quota_bytes: 500, student_cold_quota_bytes: null,
    }));
  });

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

  it("rejects a quota larger than the node's reported pool capacity, and allows it once telemetry clears", async () => {
    const node = addNodeWithPools("cap-1", 4000, 8000);
    const lab = newLab("quota-capped");
    const p = await grant(lab.id, node);
    enqueueTask.mockClear();

    expect(() => placements.updatePlacementQuota(p.id, { fastQuotaBytes: 5000 }, "admin")).toThrow(/exceeds/);
    expect(enqueueTask).not.toHaveBeenCalled();

    // At the reported cap it's allowed: this is the only lab on the node, so nothing else is
    // committed and the whole tier is still unallocated.
    placements.updatePlacementQuota(p.id, { fastQuotaBytes: 4000 }, "admin");
    expect(placements.getPlacement(p.id)!.fast_quota_bytes).toBe(4000);

    // No telemetry at all (e.g. node never reported) skips the cap rather than blocking the change.
    dbmod.db().prepare("UPDATE nodes SET pools = NULL WHERE id = ?").run(node);
    placements.updatePlacementQuota(p.id, { fastQuotaBytes: 999_999 }, "admin");
    expect(placements.getPlacement(p.id)!.fast_quota_bytes).toBe(999_999);
  });

  // RETEST-FIND-6: a per-placement cap alone accepted 7.25 TiB for one lab while another lab held
  // 64 GiB of the same 7.25 TiB tier, because a ZFS quota is a limit and not a reservation — the
  // agent's allocator only ever sees raw pool free space, which still counts what other labs were
  // promised. The sum has to be checked here or nowhere.
  it("measures a quota against what other labs on the node have already been granted", async () => {
    const node = addNodeWithPools("cap-2", 10_000, 20_000);
    const alpha = await grant(newLab("agg-alpha").id, node, { fastQuotaBytes: 6000, coldQuotaBytes: 6000 });
    const bravo = await grant(newLab("agg-bravo").id, node, { fastQuotaBytes: 1000, coldQuotaBytes: 1000 });
    enqueueTask.mockClear();

    // 10000 total - 1000 held by bravo = 9000 left for alpha. Its own current grant does not count
    // against it.
    expect(() => placements.updatePlacementQuota(alpha.id, { fastQuotaBytes: 9001 }, "admin"))
      .toThrow(/exceeds the .* still unallocated on node 'cap-2'/);
    expect(enqueueTask).not.toHaveBeenCalled();
    placements.updatePlacementQuota(alpha.id, { fastQuotaBytes: 9000 }, "admin");
    expect(placements.getPlacement(alpha.id)!.fast_quota_bytes).toBe(9000);

    // Now the tier is fully committed, so bravo cannot grow by even one byte.
    expect(() => placements.updatePlacementQuota(bravo.id, { fastQuotaBytes: 1001 }, "admin"))
      .toThrow(/exceeds/);
    // Cold is tracked independently and still has room.
    placements.updatePlacementQuota(bravo.id, { coldQuotaBytes: 14_000 }, "admin");
    expect(placements.getPlacement(bravo.id)!.cold_quota_bytes).toBe(14_000);
  });

  it("blocks a NEW placement that does not fit beside the existing ones", async () => {
    const node = addNodeWithPools("cap-3", 5000, 5000);
    await grant(newLab("fits-first").id, node, { fastQuotaBytes: 4000, coldQuotaBytes: 1000 });
    await expect(grant(newLab("does-not-fit").id, node, { fastQuotaBytes: 1500, coldQuotaBytes: 1000 }))
      .rejects.toThrow(/Fast quota .* exceeds/);
    // Cold is over budget on its own even when fast fits.
    await expect(grant(newLab("cold-too-big").id, node, { fastQuotaBytes: 500, coldQuotaBytes: 4500 }))
      .rejects.toThrow(/Cold quota .* exceeds/);
    // Exactly the remainder is accepted.
    const ok = await grant(newLab("fits-exactly").id, node, { fastQuotaBytes: 1000, coldQuotaBytes: 4000 });
    expect(ok.fast_quota_bytes).toBe(1000);
  });

  it("counts a placement that is still being deleted — its datasets are still on the node", async () => {
    const node = addNodeWithPools("cap-4", 5000, 5000);
    const doomed = await grant(newLab("still-deleting").id, node, { fastQuotaBytes: 4000, coldQuotaBytes: 4000 });
    dbmod.db().prepare("UPDATE lab_placements SET state = 'deleting' WHERE id = ?").run(doomed.id);
    await expect(grant(newLab("too-eager").id, node, { fastQuotaBytes: 2000, coldQuotaBytes: 1000 }))
      .rejects.toThrow(/exceeds/);
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

  it("also re-dispatches student.add for members the failure stranded", async () => {
    // Regression: lab.create rebuilds storage and the container but never re-runs student.add, so a
    // member stuck in `failed` stayed stuck across every retry. The only remedy was to remove the
    // placement and re-grant it, which destroys the lab's storage on that node.
    const lab = newLab("retry-strands-members");
    await students.addStudentToLab(lab.id, { username: "stuck" }, "admin");
    await students.addStudentToLab(lab.id, { username: "fine" }, "admin");
    const p = await grant(lab.id, nodeA);
    setMemberState(p.id, "stuck", "failed");
    setMemberState(p.id, "fine", "active");
    placements.markPlacementState(p.id, "failed", "temporary create failure");
    enqueueTask.mockClear();

    placements.retryPlacement(p.id, "admin");

    const adds = enqueueTask.mock.calls.filter((c) => c[1] === "student.add");
    expect(adds.map((c) => (c[2] as any).username)).toEqual(["stuck"]);
    // lab.create must be queued before the member re-adds: the node drains its queue in order.
    const kinds = enqueueTask.mock.calls.map((c) => c[1]);
    expect(kinds.indexOf("lab.create")).toBeLessThan(kinds.indexOf("student.add"));
  });
});

describe("retryPlacementMembers", () => {
  it("re-queues only the members that never reached active, with a fresh credential", async () => {
    const lab = newLab("retry-members");
    await students.addStudentToLab(lab.id, { username: "broke" }, "admin");
    await students.addStudentToLab(lab.id, { username: "works" }, "admin");
    const p = await grant(lab.id, nodeA);
    setMemberState(p.id, "broke", "failed", "ssh_askpass: Permission denied");
    setMemberState(p.id, "works", "active");
    const before = memberRow(p.id, "works").credential_secret;
    enqueueTask.mockClear();

    expect(placements.retryPlacementMembers(p.id, "admin")).toBe(1);

    const adds = enqueueTask.mock.calls.filter((c) => c[1] === "student.add");
    expect(adds.map((c) => (c[2] as any).username)).toEqual(["broke"]);
    const retried = memberRow(p.id, "broke");
    expect(retried.state).toBe("provisioning");
    expect(retried.last_error).toBeNull();
    // The active member is left completely alone -- its password may already be in use.
    const untouched = memberRow(p.id, "works");
    expect(untouched.state).toBe("active");
    expect(untouched.credential_secret).toBe(before);
  });

  it("refuses when there is nothing to retry, or the placement is being removed", async () => {
    const lab = newLab("retry-members-noop");
    await students.addStudentToLab(lab.id, { username: "done" }, "admin");
    const p = await grant(lab.id, nodeA);
    setMemberState(p.id, "done", "active");
    expect(() => placements.retryPlacementMembers(p.id, "admin")).toThrow(/already active/);

    setMemberState(p.id, "done", "failed");
    placements.destroyPlacement(p.id, "admin");
    expect(() => placements.retryPlacementMembers(p.id, "admin")).toThrow(/being removed/);
  });
});

describe("placement node alias", () => {
  it("carries the node alias so the UI can show a host that actually resolves", async () => {
    // NODE_NAME_RE forbids dots, so `node_name` can never be an FQDN; only the alias is reachable.
    const lab = newLab("alias-lab");
    const p = await grant(lab.id, nodeB);
    expect(placements.getPlacement(p.id)!.node_alias).toBeNull();
    dbmod.db().prepare("UPDATE nodes SET alias = ? WHERE id = ?").run("node-b.cs.uga.edu", nodeB);
    expect(placements.getPlacement(p.id)!.node_alias).toBe("node-b.cs.uga.edu");
    dbmod.db().prepare("UPDATE nodes SET alias = NULL WHERE id = ?").run(nodeB);
  });
});

describe("recreatePlacement", () => {
  it("changes student quota mode only through recreate and supports fast alone", async () => {
    const lab = newLab("recreate-student-quota");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();
    placements.recreatePlacement(p.id, {
      studentFastQuotaBytes: 400,
      studentColdQuotaBytes: null,
    }, "admin");
    const fresh = placements.getPlacement(p.id)!;
    expect(fresh.student_fast_quota_bytes).toBe(400);
    expect(fresh.student_cold_quota_bytes).toBeNull();
    expect(enqueueTask).toHaveBeenCalledWith(
      "node-a", "container.recreate",
      expect.objectContaining({ student_fast_quota_bytes: 400, student_cold_quota_bytes: null }),
      "admin",
    );
  });

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

  it("re-adds every existing member after recreate, since accounts live in the container's writable layer", async () => {
    const lab = newLab("recreate-members");
    await students.addStudentToLab(lab.id, { username: "alice", email: "a@uga.edu" }, "admin");
    await students.addStudentToLab(lab.id, { username: "bob" }, "admin");
    const p = await grant(lab.id, nodeA);
    enqueueTask.mockClear();

    placements.recreatePlacement(p.id, { image: "custom-ssh-v2" }, "admin");

    const calls = enqueueTask.mock.calls;
    const recreateIdx = calls.findIndex((c) => c[1] === "container.recreate");
    const addIdxs = calls.map((c, i) => (c[1] === "student.add" ? i : -1)).filter((i) => i >= 0);
    expect(recreateIdx).toBeGreaterThanOrEqual(0);
    // Every re-add must be queued after container.recreate — the agent's per-node queue is a single
    // FIFO consumer, so ordering here is what guarantees the add lands on the new container.
    expect(addIdxs.every((i) => i > recreateIdx)).toBe(true);
    expect(addIdxs.map((i) => (calls[i][2] as any).username).sort()).toEqual(["alice", "bob"]);

    const n = (dbmod.db().prepare("SELECT COUNT(*) AS n FROM placement_members WHERE placement_id=?").get(p.id) as any).n;
    expect(n).toBe(2);
  });
});

describe("SMB placement rules + shared student removal", () => {
  let ownerId: number;
  let clientId: number;

  beforeAll(() => {
    const d = dbmod.db();
    const capabilities = JSON.stringify({ runtime: { userns_start: 231072, userns_size: 65536 } });
    d.prepare("INSERT INTO nodes (name, online, created_at, cold_backend, cold_ready, capabilities) VALUES ('own-1', 1, 0, 'local_zfs', 1, ?)").run(capabilities);
    ownerId = (d.prepare("SELECT id FROM nodes WHERE name='own-1'").get() as any).id;
    d.prepare("INSERT INTO nodes (name, online, created_at, cold_backend, cold_owner_node_id, cold_ready, capabilities) VALUES ('smb-1', 1, 0, 'smb', ?, 1, ?)").run(ownerId, capabilities);
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

  it("refuses an SMB client with a different numeric userns mapping", async () => {
    const lab = newLab("smbids");
    const owner = await grant(lab.id, ownerId);
    placements.markPlacementState(owner.id, "active");
    dbmod.db().prepare("UPDATE nodes SET capabilities = ? WHERE id = ?")
      .run(JSON.stringify({ runtime: { userns_start: 999999, userns_size: 65536 } }), clientId);
    await expect(grant(lab.id, clientId)).rejects.toThrow(/same Docker userns numeric mapping/);
    dbmod.db().prepare("UPDATE nodes SET capabilities = ? WHERE id = ?")
      .run(JSON.stringify({ runtime: { userns_start: 231072, userns_size: 65536 } }), clientId);
  });

  it("defers shared cold cleanup until all placement removals succeed", async () => {
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
    expect(byNode["own-1"]).toMatchObject({ delete_data: true, removal_id: expect.any(String) });
    expect(byNode["smb-1"]).toMatchObject({ delete_data: true, removal_id: byNode["own-1"].removal_id });
    expect(byNode["own-1"].cold_cleanup_nodes).toEqual(["own-1"]);
    expect(byNode["own-1"]).not.toHaveProperty("delete_cold");
  });

  it("queues owner cold cleanup only after every removal task is ok", () => {
    const d = dbmod.db();
    const removalId = "removal-test-1";
    const params = JSON.stringify({
      lab: "smblab3", username: "alice", delete_data: true,
      removal_id: removalId, cold_cleanup_nodes: ["own-1"],
    });
    const insert = d.prepare(
      `INSERT INTO task_log
       (task_uuid, node, action, params, state, created_at, updated_at)
       VALUES (?, ?, 'student.remove', ?, ?, 1, 1)`,
    );
    insert.run("remove-owner-test", "own-1", params, "ok");
    insert.run("remove-client-test", "smb-1", params, "sent");
    enqueueTask.mockClear();
    placements.completeStudentRemoval("remove-owner-test");
    expect(enqueueTask).not.toHaveBeenCalled();

    d.prepare("UPDATE task_log SET state = 'ok' WHERE task_uuid = 'remove-client-test'").run();
    placements.completeStudentRemoval("remove-client-test");
    expect(enqueueTask).toHaveBeenCalledWith(
      "own-1",
      "student.delete_cold",
      { lab: "smblab3", username: "alice", removal_id: removalId },
      undefined,
    );
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

  it("lets the owner tear down once its clients are already deleting (destroyLab ordering)", async () => {
    const lab = newLab("smblab5");
    const owner = await grant(lab.id, ownerId);
    placements.markPlacementState(owner.id, "active");
    const client = await grant(lab.id, clientId);
    // Client marked deleting but not yet confirmed by its node — the owner must not be blocked,
    // or destroyLab could never queue the owner teardown in the same pass.
    placements.destroyPlacement(client.id, "admin");
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

describe("forceDeletePlacement", () => {
  const setOnline = (name: string, online: number) =>
    dbmod.db().prepare("UPDATE nodes SET online = ? WHERE name = ?").run(online, name);

  it("refuses while the node is online", async () => {
    const lab = newLab("force1");
    const p = await grant(lab.id, nodeA);
    expect(() => placements.forceDeletePlacement(p.id, "admin")).toThrow(/online/);
    expect(placements.getPlacement(p.id)).toBeDefined();
  });

  it("drops the row immediately for an offline node and queues best-effort cleanup", async () => {
    const lab = newLab("force2");
    const p = await grant(lab.id, nodeA);
    setOnline("node-a", 0);
    enqueueTask.mockClear();
    placements.forceDeletePlacement(p.id, "admin");
    expect(placements.getPlacement(p.id)).toBeUndefined();
    // Cleanup is still queued so the orphaned container/datasets go away if the node reconnects.
    expect(enqueueTask).toHaveBeenCalledWith("node-a", "lab.destroy", { lab: "force2" }, "admin");
    expect(
      dbmod.db().prepare("SELECT 1 FROM audit_log WHERE action='placement.force_delete' AND target='force2@node-a'").get(),
    ).toBeTruthy();
    setOnline("node-a", 1);
  });

  it("keeps the SMB-owner guard: the offline clients must be force-removed first", async () => {
    const d = dbmod.db();
    const ownId = (d.prepare("SELECT id FROM nodes WHERE name='own-1'").get() as any).id;
    const cliId = (d.prepare("SELECT id FROM nodes WHERE name='smb-1'").get() as any).id;
    const lab = newLab("force3");
    const owner = await grant(lab.id, ownId);
    placements.markPlacementState(owner.id, "active");
    const client = await grant(lab.id, cliId);
    d.prepare("UPDATE nodes SET online = 0 WHERE name IN ('own-1','smb-1')").run();
    expect(() => placements.forceDeletePlacement(owner.id, "admin")).toThrow(/owns the shared cold storage/);
    placements.forceDeletePlacement(client.id, "admin");
    expect(() => placements.forceDeletePlacement(owner.id, "admin")).not.toThrow();
    expect(placements.getPlacement(owner.id)).toBeUndefined();
    d.prepare("UPDATE nodes SET online = 1 WHERE name IN ('own-1','smb-1')").run();
  });
});

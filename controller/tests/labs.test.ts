import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-labs-"));
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
let nodeId: number;
let port = 50000;

const OPTS = { cpus: "4", memory: "8g", shm_size: "1g", rootfs_quota: "300g", restart: "unless-stopped" };

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  labs = await import("../src/lib/labs");
  placements = await import("../src/lib/placements");
  dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, 0)").run();
  nodeId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
});

beforeEach(() => {
  enqueueTask.mockClear();
  sendCredentialEmail.mockClear();
  sendRemovalEmail.mockClear();
});

const makeLab = (name: string) => labs.createLab({ name, piName: "Dr. X", piEmail: "pi@uga.edu", actor: "admin" });
const makePlacement = (labId: number) =>
  placements.createPlacement({
    labId,
    nodeId,
    fastQuotaBytes: 1000,
    coldQuotaBytes: 2000,
    sshPort: ++port,
    image: "custom-ssh",
    containerOptions: OPTS,
    actor: "admin",
  });

describe("lab name validation (M-04)", () => {
  it("accepts a simple name and rejects junk", () => {
    expect(labs.isValidLabName("bio-101")).toBe(true);
    expect(labs.isValidLabName("../etc")).toBe(false);
    expect(labs.isValidLabName("a/b")).toBe(false);
    expect(labs.isValidLabName("has space")).toBe(false);
    expect(labs.isValidLabName("")).toBe(false);
  });

  it("createLab throws on an invalid name (no task enqueued)", () => {
    expect(() => makeLab("bad/name")).toThrow(/Invalid lab name/);
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});

describe("createLab (logical, node-independent)", () => {
  it("inserts the lab + PI metadata and audits, without enqueuing any node task", () => {
    const lab = makeLab("bio");
    expect(lab.name).toBe("bio");
    expect(lab.pi_name).toBe("Dr. X");
    expect(lab.pi_email).toBe("pi@uga.edu");
    expect(enqueueTask).not.toHaveBeenCalled(); // node tasks happen on placement, not lab creation

    const audit = dbmod.db().prepare("SELECT * FROM audit_log WHERE action='lab.create' AND target='bio'").get();
    expect(audit).toBeTruthy();
  });

  it("rejects a duplicate name", () => {
    expect(() => makeLab("bio")).toThrow(/already exists/);
  });
});

describe("getters", () => {
  it("getLabByName / getLab / listLabs with derived counts", async () => {
    const chem = makeLab("chem");
    await makePlacement(chem.id);
    const byName = labs.getLabByName("chem")!;
    expect(labs.getLab(byName.id)!.name).toBe("chem");
    expect(labs.getLab(123456)).toBeUndefined();

    const summary = labs.listLabs().find((l) => l.name === "chem")!;
    expect(summary.placement_count).toBe(1);
    expect(summary.active_placements).toBe(0); // still 'provisioning' until the agent confirms
    expect(summary.student_count).toBe(0);
    expect(labs.listLabPlacementSummaries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lab_id: chem.id, node_name: "gpu-1", state: "provisioning" }),
      ]),
    );

    const names = labs.listLabs().map((l) => l.name);
    expect([...names]).toEqual([...names].sort());
  });
});

describe("updateLabMeta", () => {
  it("updates PI metadata and audits", () => {
    const lab = makeLab("phys");
    labs.updateLabMeta(lab.id, { piName: "Dr. Y", piEmail: "y@uga.edu" }, "admin");
    const row = labs.getLab(lab.id)!;
    expect(row.pi_name).toBe("Dr. Y");
    expect(row.pi_email).toBe("y@uga.edu");
    expect(dbmod.db().prepare("SELECT 1 FROM audit_log WHERE action='lab.update_meta' AND target='phys'").get()).toBeTruthy();
  });
});

describe("destroyLab", () => {
  it("with no placements: deletes the lab and orphan-only students, keeps shared ones", () => {
    const a = makeLab("alpha");
    const b = makeLab("beta");
    const db = dbmod.db();
    const sole = Number(db.prepare("INSERT INTO students (username, linux_uid, created_at, updated_at) VALUES ('sole', 10000, 0, 0)").run().lastInsertRowid);
    const shared = Number(db.prepare("INSERT INTO students (username, linux_uid, created_at, updated_at) VALUES ('shared', 10001, 0, 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(a.id, sole);
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(a.id, shared);
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(b.id, shared);

    const res = labs.destroyLab(a.id, "admin");
    expect(res).toEqual({ deleted: true, teardownStarted: 0 });
    expect(labs.getLab(a.id)).toBeUndefined();
    expect(db.prepare("SELECT id FROM students WHERE id = ?").get(sole)).toBeUndefined();
    expect(db.prepare("SELECT id FROM students WHERE id = ?").get(shared)).toBeTruthy();
  });

  it("with placements: tears them down (kept until confirmed), then deletes once gone", async () => {
    const lab = makeLab("geo");
    const placement = await makePlacement(lab.id);
    enqueueTask.mockClear();

    const res = labs.destroyLab(lab.id, "admin");
    expect(res).toEqual({ deleted: false, teardownStarted: 1 });
    expect(labs.getLab(lab.id)).toBeTruthy(); // lab kept until the node confirms
    expect(placements.getPlacement(placement.id)!.state).toBe("deleting");
    expect(enqueueTask).toHaveBeenCalledWith("gpu-1", "lab.destroy", { lab: "geo" }, "admin");

    // Agent confirms destruction -> placement row removed; deleting the lab again removes it.
    placements.confirmPlacementDestroyed("geo", "gpu-1");
    expect(placements.getPlacement(placement.id)).toBeUndefined();
    expect(labs.destroyLab(lab.id, "admin")).toEqual({ deleted: true, teardownStarted: 0 });
    expect(labs.getLab(lab.id)).toBeUndefined();
  });

  it("is a no-op for an unknown lab", () => {
    expect(labs.destroyLab(999999)).toEqual({ deleted: false, teardownStarted: 0 });
  });

  it("force: purges placements on offline nodes and deletes the lab in the same call", async () => {
    const lab = makeLab("ghost");
    const placement = await makePlacement(lab.id);
    dbmod.db().prepare("UPDATE nodes SET online = 0 WHERE name='gpu-1'").run();

    // Without force the lab waits forever on the offline node's confirmation.
    expect(labs.destroyLab(lab.id, "admin")).toEqual({ deleted: false, teardownStarted: 1 });

    const res = labs.destroyLab(lab.id, "admin", true);
    expect(res).toEqual({ deleted: true, teardownStarted: 0 });
    expect(labs.getLab(lab.id)).toBeUndefined();
    expect(placements.getPlacement(placement.id)).toBeUndefined();
    dbmod.db().prepare("UPDATE nodes SET online = 1 WHERE name='gpu-1'").run();
  });

  it("force: placements on online nodes still get a normal, confirmed teardown", async () => {
    const lab = makeLab("mixed");
    const placement = await makePlacement(lab.id);

    const res = labs.destroyLab(lab.id, "admin", true);
    expect(res).toEqual({ deleted: false, teardownStarted: 1 });
    expect(labs.getLab(lab.id)).toBeTruthy();
    expect(placements.getPlacement(placement.id)!.state).toBe("deleting");
  });
});

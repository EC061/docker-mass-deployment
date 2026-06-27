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

let dbmod: typeof import("../src/lib/db");
let labs: typeof import("../src/lib/labs");
let nodeId: number;

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  labs = await import("../src/lib/labs");
  dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, 0)").run();
  nodeId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
});

beforeEach(() => {
  enqueueTask.mockClear();
});

function makeLab(name: string) {
  return labs.createLab({
    name,
    nodeId,
    piEmail: "pi@uga.edu",
    fastQuotaBytes: 1000,
    slowQuotaBytes: 2000,
    image: "custom-ssh",
    sshPort: 50001,
    containerOptions: { cpus: "4" },
  });
}

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

describe("createLab", () => {
  it("inserts the lab, enqueues lab.create, and audits", () => {
    const lab = makeLab("bio");
    expect(lab.name).toBe("bio");
    expect(lab.node_name).toBe("gpu-1");
    expect(lab.status).toBe("provisioning");

    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "lab.create",
      expect.objectContaining({
        lab: "bio",
        fast_quota_bytes: 1000,
        slow_quota_bytes: 2000,
        image: "custom-ssh",
        ssh_port: 50001,
        container_options: { cpus: "4" },
      }),
      undefined,
    );

    const audit = dbmod
      .db()
      .prepare("SELECT * FROM audit_log WHERE action='lab.create' AND target='bio'")
      .get() as any;
    expect(audit).toBeTruthy();
    expect(audit.detail).toBe("node=gpu-1");
  });

  it("throws for an unknown node", () => {
    expect(() =>
      labs.createLab({ name: "x", nodeId: 9999, fastQuotaBytes: 1, slowQuotaBytes: 1, image: "i" }),
    ).toThrow(/Unknown node/);
  });
});

describe("getters", () => {
  it("getLabByName and getLab return the row with node join", () => {
    makeLab("chem");
    const byName = labs.getLabByName("chem")!;
    expect(byName.online).toBe(1);
    expect(labs.getLab(byName.id)!.name).toBe("chem");
    expect(labs.getLab(123456)).toBeUndefined();
  });

  it("listLabs returns all labs ordered by name", () => {
    const names = labs.listLabs().map((l) => l.name);
    expect(names).toContain("bio");
    expect(names).toContain("chem");
    expect([...names]).toEqual([...names].sort());
  });
});

describe("updateQuota", () => {
  it("updates only provided fields and enqueues lab.set_quota", () => {
    const lab = makeLab("phys");
    enqueueTask.mockClear();
    labs.updateQuota(lab.id, 5000, undefined, "admin");
    const row = labs.getLab(lab.id)!;
    expect(row.fast_quota_bytes).toBe(5000);
    expect(row.slow_quota_bytes).toBe(2000); // unchanged
    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "lab.set_quota",
      expect.objectContaining({ lab: "phys", fast_quota_bytes: 5000 }),
      "admin",
    );
    expect(enqueueTask.mock.calls[0][2]).not.toHaveProperty("slow_quota_bytes");
  });

  it("throws for an unknown lab", () => {
    expect(() => labs.updateQuota(999999, 1, 1)).toThrow(/Unknown lab/);
  });
});

describe("destroyLab", () => {
  it("enqueues lab.destroy, deletes the row, and audits", () => {
    const lab = makeLab("geo");
    enqueueTask.mockClear();
    labs.destroyLab(lab.id, "admin");
    expect(labs.getLab(lab.id)).toBeUndefined();
    expect(enqueueTask).toHaveBeenCalledWith("gpu-1", "lab.destroy", { lab: "geo" }, "admin");
    const audit = dbmod
      .db()
      .prepare("SELECT * FROM audit_log WHERE action='lab.destroy' AND target='geo'")
      .get();
    expect(audit).toBeTruthy();
  });

  it("is a no-op for an unknown lab (no enqueue)", () => {
    labs.destroyLab(999999);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("removes students that belonged only to the destroyed lab, keeps shared ones", () => {
    const a = makeLab("alpha");
    const b = makeLab("beta");
    const db = dbmod.db();
    // sole: only in alpha. shared: in both alpha and beta.
    const sole = Number(
      db.prepare("INSERT INTO students (username, created_at) VALUES ('sole', 0)").run().lastInsertRowid,
    );
    const shared = Number(
      db.prepare("INSERT INTO students (username, created_at) VALUES ('shared', 0)").run().lastInsertRowid,
    );
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(a.id, sole);
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(a.id, shared);
    db.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(b.id, shared);

    labs.destroyLab(a.id, "admin");

    // sole had no other membership -> deleted; shared still in beta -> kept.
    expect(db.prepare("SELECT id FROM students WHERE id = ?").get(sole)).toBeUndefined();
    expect(db.prepare("SELECT id FROM students WHERE id = ?").get(shared)).toBeTruthy();
    // memberships in the destroyed lab are gone (ON DELETE CASCADE).
    expect(db.prepare("SELECT 1 FROM lab_members WHERE lab_id = ?").get(a.id)).toBeUndefined();
  });
});

describe("markLabStatus", () => {
  it("transitions a provisioning lab to active (and to failed)", () => {
    const lab = makeLab("statuslab");
    expect(labs.getLab(lab.id)!.status).toBe("provisioning");
    labs.markLabStatus("statuslab", "active");
    expect(labs.getLab(lab.id)!.status).toBe("active");
    labs.markLabStatus("statuslab", "failed");
    expect(labs.getLab(lab.id)!.status).toBe("failed");
  });

  it("is a silent no-op for an unknown lab name", () => {
    expect(() => labs.markLabStatus("nope", "active")).not.toThrow();
  });
});

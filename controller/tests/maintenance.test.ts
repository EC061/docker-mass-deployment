import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-maint-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const enqueueTask = vi.fn(() => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));

const backupAll = vi.fn(async () => ({ ok: true }));
vi.mock("../src/lib/backup", () => ({ backupAll }));

let dbmod: typeof import("../src/lib/db");
let maintenance: typeof import("../src/lib/maintenance");
let settings: typeof import("../src/lib/settings");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  maintenance = await import("../src/lib/maintenance");
  settings = await import("../src/lib/settings");
});

beforeEach(() => {
  enqueueTask.mockClear();
});

describe("pruneOldData", () => {
  it("deletes logs and gpu_events older than the retention window, keeping recent rows", () => {
    settings.setSetting("logRetentionDays", 30);
    const now = Date.now();
    const old = now - 40 * 86400 * 1000;
    const recent = now - 1 * 86400 * 1000;

    const insLog = dbmod
      .db()
      .prepare("INSERT INTO logs (node, level, source, msg, ts) VALUES ('n','INFO','s','m',?)");
    insLog.run(old);
    insLog.run(old);
    insLog.run(recent);

    const insGpu = dbmod
      .db()
      .prepare("INSERT INTO gpu_events (node, state, ts) VALUES ('n','warned',?)");
    insGpu.run(old);
    insGpu.run(recent);

    const result = maintenance.pruneOldData();
    expect(result.logs).toBe(2);
    expect(result.gpuEvents).toBe(1);

    const logsLeft = dbmod.db().prepare("SELECT COUNT(*) AS n FROM logs").get() as any;
    expect(logsLeft.n).toBe(1);
    const gpuLeft = dbmod.db().prepare("SELECT COUNT(*) AS n FROM gpu_events").get() as any;
    expect(gpuLeft.n).toBe(1);
  });

  it("removes nothing when all rows are within retention", () => {
    dbmod.db().prepare("DELETE FROM logs").run();
    dbmod.db().prepare("DELETE FROM gpu_events").run();
    dbmod
      .db()
      .prepare("INSERT INTO logs (node, level, source, msg, ts) VALUES ('n','INFO','s','m',?)")
      .run(Date.now());
    const result = maintenance.pruneOldData();
    expect(result.logs).toBe(0);
    expect(result.gpuEvents).toBe(0);
  });
});

describe("scheduleOldFileScans", () => {
  let bioId: number;

  beforeAll(() => {
    dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('on-1', 1, 0)").run();
    dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('down-1', 0, 0)").run();
    const onId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='on-1'").get() as any).id;
    const downId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='down-1'").get() as any).id;
    const insLab = dbmod
      .db()
      .prepare(
        `INSERT INTO labs (name, node_id, fast_quota_bytes, slow_quota_bytes, image, created_at)
         VALUES (?, ?, 1, 1, 'custom-ssh', 0)`,
      );
    insLab.run("bio", onId);
    insLab.run("offline-lab", downId);
    bioId = (dbmod.db().prepare("SELECT id FROM labs WHERE name='bio'").get() as any).id;
    dbmod.db().prepare("INSERT INTO students (username, created_at) VALUES ('alice', 0)").run();
    const sid = (dbmod.db().prepare("SELECT id FROM students WHERE username='alice'").get() as any).id;
    dbmod
      .db()
      .prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)")
      .run(bioId, sid);
  });

  it("does nothing when disabled", () => {
    settings.setSetting("oldFileScanEnabled", false);
    expect(maintenance.scheduleOldFileScans()).toEqual([]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("scans due labs on online nodes; skips offline nodes and recently-scanned labs", () => {
    settings.setSetting("oldFileScanEnabled", true);
    settings.setSetting("oldFileScanIntervalDays", 1);
    settings.setSetting("oldFileThresholdDays", 30);
    const now = 1_000_000_000_000;

    const scheduled = maintenance.scheduleOldFileScans(now);
    expect(scheduled).toContain("bio");
    expect(scheduled).not.toContain("offline-lab");
    expect(enqueueTask).toHaveBeenCalledWith(
      "on-1",
      "oldfiles.scan",
      { lab: "bio", users: ["alice"], threshold_days: 30 },
      "oldfile-scheduler",
    );
    const row = dbmod.db().prepare("SELECT last_oldfile_scan FROM labs WHERE id = ?").get(bioId) as {
      last_oldfile_scan: number;
    };
    expect(row.last_oldfile_scan).toBe(now);

    // An hour later is still within the 1-day interval -> not due.
    enqueueTask.mockClear();
    expect(maintenance.scheduleOldFileScans(now + 3600 * 1000)).not.toContain("bio");
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});

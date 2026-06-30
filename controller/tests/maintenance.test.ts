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

describe("pruneLogs caps", () => {
  const insLog = (msg: string, ts: number) =>
    dbmod
      .db()
      .prepare("INSERT INTO logs (node, level, source, msg, ts) VALUES ('n','INFO','s',?,?)")
      .run(msg, ts);

  beforeEach(() => {
    dbmod.db().prepare("DELETE FROM logs").run();
    settings.setSetting("logRetentionDays", 0); // isolate count/size caps from the age cap
    settings.setSetting("logMaxEntries", 0);
    settings.setSetting("logMaxSizeMb", 0);
  });

  it("keeps only the newest logMaxEntries rows", () => {
    settings.setSetting("logMaxEntries", 3);
    for (let i = 0; i < 10; i++) insLog(`m${i}`, 1000 + i);
    const removed = maintenance.pruneLogs();
    expect(removed).toBe(7);
    const rows = dbmod.db().prepare("SELECT msg FROM logs ORDER BY id").all() as { msg: string }[];
    expect(rows.map((r) => r.msg)).toEqual(["m7", "m8", "m9"]);
  });

  it("does nothing when row count is within the entry cap", () => {
    settings.setSetting("logMaxEntries", 5);
    for (let i = 0; i < 3; i++) insLog(`m${i}`, 1000 + i);
    expect(maintenance.pruneLogs()).toBe(0);
    const n = (dbmod.db().prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n;
    expect(n).toBe(3);
  });

  it("keeps the newest rows within the size cap and drops the rest", () => {
    const big = "x".repeat(1000); // ~1 KB per row
    for (let i = 0; i < 20; i++) insLog(`${i}-${big}`, 1000 + i);
    settings.setSetting("logMaxSizeMb", 5 / 1024); // ~5 KB cap
    const removed = maintenance.pruneLogs();
    expect(removed).toBeGreaterThan(0);
    expect(maintenance.logsContentBytes()).toBeLessThanOrEqual(5 * 1024);
    // The most recent row always survives.
    const newest = dbmod.db().prepare("SELECT msg FROM logs ORDER BY id DESC LIMIT 1").get() as {
      msg: string;
    };
    expect(newest.msg.startsWith("19-")).toBe(true);
  });

  it("applies all three caps together, removing the union of surplus rows", () => {
    settings.setSetting("logRetentionDays", 30);
    settings.setSetting("logMaxEntries", 5);
    const now = Date.now();
    insLog("ancient", now - 40 * 86400 * 1000); // dropped by age
    for (let i = 0; i < 8; i++) insLog(`r${i}`, now - i * 1000); // newest 5 kept by count
    maintenance.pruneLogs(now);
    const rows = dbmod.db().prepare("SELECT msg FROM logs").all() as { msg: string }[];
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.msg === "ancient")).toBe(false);
  });
});

describe("scheduleUsageScans", () => {
  let bioId: number;

  let bioPlacementId: number;

  beforeAll(() => {
    const d = dbmod.db();
    d.prepare("INSERT INTO nodes (name, online, created_at) VALUES ('on-1', 1, 0)").run();
    d.prepare("INSERT INTO nodes (name, online, created_at) VALUES ('down-1', 0, 0)").run();
    const onId = (d.prepare("SELECT id FROM nodes WHERE name='on-1'").get() as any).id;
    const downId = (d.prepare("SELECT id FROM nodes WHERE name='down-1'").get() as any).id;
    const insLab = d.prepare("INSERT INTO labs (name, created_at, updated_at) VALUES (?, 0, 0)");
    insLab.run("bio");
    insLab.run("offline-lab");
    bioId = (d.prepare("SELECT id FROM labs WHERE name='bio'").get() as any).id;
    const offlineId = (d.prepare("SELECT id FROM labs WHERE name='offline-lab'").get() as any).id;
    // bio is active on an online node; offline-lab is active on an offline node (must be skipped).
    const insP = d.prepare(
      `INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
       VALUES (?, ?, 1, 1, ?, 'custom-ssh', 'active', 0, 0)`,
    );
    insP.run(bioId, onId, 40000);
    insP.run(offlineId, downId, 40000);
    bioPlacementId = (d.prepare("SELECT id FROM lab_placements WHERE lab_id=?").get(bioId) as any).id;
    d.prepare("INSERT INTO students (username, linux_uid, created_at, updated_at) VALUES ('alice', 10000, 0, 0)").run();
    const sid = (d.prepare("SELECT id FROM students WHERE username='alice'").get() as any).id;
    d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)").run(bioId, sid);
  });

  it("does nothing when disabled", () => {
    settings.setSetting("usageScanEnabled", false);
    expect(maintenance.scheduleUsageScans()).toEqual([]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("only runs during the configured hour", () => {
    settings.setSetting("usageScanEnabled", true);
    settings.setSetting("usageScanTimezone", "UTC");
    settings.setSetting("usageScanHour", 1);
    // 05:00 UTC -> hour 5, which does not match the configured hour 1, so nothing is scheduled.
    expect(maintenance.scheduleUsageScans(Date.UTC(2001, 8, 9, 5, 0, 0))).toEqual([]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("scans online-node labs once a night; skips offline nodes and respects the re-fire gap", () => {
    settings.setSetting("usageScanEnabled", true);
    // An invalid timezone bypasses the hour gate (hourInTimezone -> null), so this exercises the
    // gap guard purely via the timestamps rather than wall-clock hour math.
    settings.setSetting("usageScanTimezone", "Not/AZone");
    const t0 = 1_000_000_000_000;

    const scheduled = maintenance.scheduleUsageScans(t0);
    expect(scheduled).toContain("bio@on-1");
    expect(scheduled).not.toContain("offline-lab@down-1");
    expect(enqueueTask).toHaveBeenCalledWith(
      "on-1",
      "usage.scan",
      { lab: "bio", users: ["alice"] },
      "usage-scheduler",
    );
    const row = dbmod.db().prepare("SELECT last_usage_scan FROM lab_placements WHERE id = ?").get(bioPlacementId) as {
      last_usage_scan: number;
    };
    expect(row.last_usage_scan).toBe(t0);

    // An hour later is well within the ~20h re-fire gap -> bio is not scanned again.
    expect(maintenance.scheduleUsageScans(t0 + 3600 * 1000)).not.toContain("bio@on-1");

    // The next night (past the gap) -> due again.
    expect(maintenance.scheduleUsageScans(t0 + 21 * 3600 * 1000)).toContain("bio@on-1");
  });
});

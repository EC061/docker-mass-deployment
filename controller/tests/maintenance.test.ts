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

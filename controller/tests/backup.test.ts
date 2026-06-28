import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-p6-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// In-memory WebDAV mock.
const store = new Map<string, Buffer>();
vi.mock("../src/lib/webdav", () => ({
  ensureCollection: vi.fn(async () => {}),
  put: vi.fn(async (_cfg: unknown, name: string, data: Buffer) => {
    store.set(name, data);
  }),
  get: vi.fn(async (_cfg: unknown, name: string) => {
    const d = store.get(name);
    if (!d) throw new Error("not found");
    return d;
  }),
  del: vi.fn(async (_cfg: unknown, name: string) => {
    store.delete(name);
  }),
  list: vi.fn(async () => [...store.keys()]),
}));

let dbmod: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");
let backup: typeof import("../src/lib/backup");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
  backup = await import("../src/lib/backup");
  dbmod.db().prepare("INSERT INTO settings (key, value) VALUES ('x','1')").run();
  settings.setSetting("webdavUrl", "https://dav.example/labmgr");
  // Keep the newest 2; disable the weekly/monthly/yearly tiers so the test exercises plain pruning.
  settings.setSetting("backupKeepRecent", 2);
  settings.setSetting("backupKeepWeekly", 0);
  settings.setSetting("backupKeepMonthly", 0);
  settings.setSetting("backupKeepYearly", 0);
});

describe("controller backup", () => {
  it("uploads a timestamped + latest snapshot that is a valid DB", async () => {
    const res = await backup.backupNow(1000);
    expect(res.ok).toBe(true);
    expect(store.has("controller-1000.db")).toBe(true);
    expect(store.has("controller-latest.db")).toBe(true);
    const snap = store.get("controller-latest.db")!;
    expect(snap.subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("prunes timestamped backups beyond retention", async () => {
    await backup.backupNow(2000);
    await backup.backupNow(3000); // keepRecent=2 -> oldest (1000) pruned
    const names = (await backup.listBackups()).map((e) => e.name);
    expect(names).not.toContain("controller-1000.db");
    expect(names).toContain("controller-3000.db");
    expect(names).toContain("controller-2000.db");
  });

  it("stages a restore to <dbPath>.restore", async () => {
    const res = await backup.stageRestore("controller-3000.db");
    expect(res.ok).toBe(true);
    const staged = `${process.env.DB_PATH}.restore`;
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged).subarray(0, 15).toString()).toBe("SQLite format 3");
    rmSync(staged);
  });
});

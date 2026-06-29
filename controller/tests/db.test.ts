import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-db-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
});

describe("db singleton", () => {
  it("returns the same connection on repeated calls", () => {
    expect(dbmod.db()).toBe(dbmod.db());
  });

  it("opens in WAL journal mode with foreign keys enforced", () => {
    expect(String(dbmod.db().pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(dbmod.db().pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("migrations", () => {
  it("records every shipped migration exactly once", () => {
    const ids = (dbmod.db().prepare("SELECT id FROM _migrations ORDER BY id").all() as any[]).map(
      (r) => r.id,
    );
    expect(ids).toContain("0001_init");
    expect(ids).toContain("0002_scrub");
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("created the core tables", () => {
    const tables = new Set(
      (
        dbmod.db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]
      ).map((r) => r.name),
    );
    for (const t of ["admins", "settings", "nodes", "labs", "students", "lab_members", "task_log", "logs"]) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("applied 0002_scrub columns to nodes", () => {
    const cols = (dbmod.db().prepare("PRAGMA table_info(nodes)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("last_scrub");
    expect(cols).toContain("scrub_status");
  });

  it("enforces foreign keys (orphan placement insert rejected)", () => {
    expect(() =>
      dbmod
        .db()
        .prepare(
          `INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, ssh_port, image, created_at, updated_at)
           VALUES (999999, 999999, 1, 1, 'i', 0, 0)`,
        )
        .run(),
    ).toThrow();
  });
});

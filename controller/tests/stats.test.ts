import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-stats-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");
let stats: typeof import("../src/lib/stats");

function sample(labId: number, studentId: number | null, pool: string, used: number, ts: number, quota: number | null = null) {
  dbmod
    .db()
    .prepare(
      "INSERT INTO storage_samples (lab_id, student_id, pool, used_bytes, quota_bytes, ts) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(labId, studentId, pool, used, quota, ts);
}

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  stats = await import("../src/lib/stats");
  const d = dbmod.db();
  d.prepare("INSERT INTO nodes (id, name, online, created_at) VALUES (1, 'node-a', 1, 0)").run();
  d.prepare(
    `INSERT INTO labs (id, name, node_id, fast_quota_bytes, slow_quota_bytes, image, status, created_at)
     VALUES (1, 'bio', 1, 2000, 3000, 'img-x', 'active', 0)`,
  ).run();
  d.prepare("INSERT INTO students (id, username, name, created_at) VALUES (1, 'alice', 'Alice A.', 0)").run();
  d.prepare("INSERT INTO students (id, username, name, created_at) VALUES (2, 'bob', 'Bob B.', 0)").run();
  d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (1, 1, 0)").run();
  d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (1, 2, 0)").run();
});

describe("buildStats", () => {
  it("groups latest per-student and lab-level usage by node and lab", () => {
    // Two docker samples for alice; the newer (ts=200) wins.
    sample(1, 1, "docker", 100, 100);
    sample(1, 1, "docker", 150, 200);
    sample(1, 2, "docker", 80, 200);
    // Lab-level (whole image) + fast/slow quota rows.
    sample(1, null, "docker", 300, 200);
    sample(1, null, "fast", 500, 200, 2000);
    sample(1, null, "slow", 200, 200, 3000);

    const nodes = stats.buildStats();
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.node).toBe("node-a");
    expect(node.totalImageBytes).toBe(300);

    const lab = node.labs[0];
    expect(lab.labName).toBe("bio");
    expect(lab.image).toBe("img-x");
    // Sorted by docker desc: alice (150) before bob (80).
    expect(lab.students.map((s) => s.username)).toEqual(["alice", "bob"]);
    expect(lab.students[0].docker).toBe(150); // latest, not 100
    expect(lab.students[1].docker).toBe(80);
    // No per-student fast/slow rows -> null.
    expect(lab.students[0].fast).toBeNull();
    expect(lab.aggregate.docker).toBe(300);
    expect(lab.aggregate.fast).toEqual({ used: 500, quota: 2000 });
    expect(lab.aggregate.slow).toEqual({ used: 200, quota: 3000 });
  });
});

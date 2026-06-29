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

let uuidSeq = 0;
function scanTask(node: string, lab: string, state: string, createdAt: number) {
  dbmod
    .db()
    .prepare(
      `INSERT INTO task_log (task_uuid, node, action, params, state, created_at, updated_at)
       VALUES (?, ?, 'usage.scan', ?, ?, ?, ?)`,
    )
    .run(`scan-${uuidSeq++}`, node, JSON.stringify({ lab }), state, createdAt, createdAt);
}

function findLab(name: string) {
  return stats
    .buildStats()
    .find((n) => n.node === "node-a")!
    .labs.find((l) => l.labName === name)!;
}

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
    expect(lab.live.image).toBe(300);
    expect(lab.live.fast).toEqual({ used: 500, quota: 2000 });
    expect(lab.live.slow).toEqual({ used: 200, quota: 3000 });
  });
});

describe("scanPending", () => {
  // Each scenario gets its own lab on node-a so their scan tasks don't collide.
  beforeAll(() => {
    const d = dbmod.db();
    for (const [id, name] of [[10, "queued"], [11, "sent"], [12, "fresh-ingest"], [13, "landed"], [14, "expired"], [15, "failed"], [16, "noscan"]] as const) {
      d.prepare(
        `INSERT INTO labs (id, name, node_id, fast_quota_bytes, slow_quota_bytes, image, status, created_at)
         VALUES (?, ?, 1, 2000, 3000, 'img-x', 'active', 0)`,
      ).run(id, name);
    }
  });

  it("is true while a scan task is queued or sent", () => {
    scanTask("node-a", "queued", "queued", Date.now());
    scanTask("node-a", "sent", "sent", Date.now());
    expect(findLab("queued").scanPending).toBe(true);
    expect(findLab("sent").scanPending).toBe(true);
  });

  it("stays true after the task is ok until the fresh numbers land (ingest gap)", () => {
    const created = Date.now();
    scanTask("node-a", "fresh-ingest", "ok", created);
    // usage_scanned_at still predates the request -> data not ingested yet.
    dbmod.db().prepare("UPDATE labs SET usage_scanned_at = ? WHERE name = 'fresh-ingest'").run(created - 1000);
    expect(findLab("fresh-ingest").scanPending).toBe(true);
  });

  it("flips false once usage_scanned_at advances past the request (data landed)", () => {
    const created = Date.now();
    scanTask("node-a", "landed", "ok", created);
    dbmod.db().prepare("UPDATE labs SET usage_scanned_at = ? WHERE name = 'landed'").run(created + 1000);
    expect(findLab("landed").scanPending).toBe(false);
  });

  it("does not keep an ok task pending forever if the heartbeat never lands", () => {
    // Requested 20 min ago, still no fresh scan -> grace window expired, show the button again.
    scanTask("node-a", "expired", "ok", Date.now() - 20 * 60 * 1000);
    expect(findLab("expired").scanPending).toBe(false);
  });

  it("is false for a failed scan and when there is no scan task", () => {
    scanTask("node-a", "failed", "failed", Date.now());
    expect(findLab("failed").scanPending).toBe(false);
    expect(findLab("noscan").scanPending).toBe(false);
  });

  it("tracks only the latest task per lab", () => {
    // An old ok (data landed) followed by a brand-new queued -> pending again.
    scanTask("node-a", "noscan", "ok", Date.now() - 5000);
    dbmod.db().prepare("UPDATE labs SET usage_scanned_at = ? WHERE name = 'noscan'").run(Date.now() - 4000);
    scanTask("node-a", "noscan", "queued", Date.now());
    expect(findLab("noscan").scanPending).toBe(true);
  });
});

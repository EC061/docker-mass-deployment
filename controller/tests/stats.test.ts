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

/** Create a logical lab + a single placement on node 1 (a lab "block" on the Stats page). */
function mkLabPlacement(labId: number, name: string, placementId: number, sshPort: number) {
  const d = dbmod.db();
  d.prepare("INSERT INTO labs (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)").run(labId, name);
  d.prepare(
    `INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
     VALUES (?, ?, 1, 2000, 3000, ?, 'img-x', 'active', 0, 0)`,
  ).run(placementId, labId, sshPort);
}

function sample(placementId: number, studentId: number | null, pool: string, used: number, ts: number, quota: number | null = null) {
  dbmod
    .db()
    .prepare(
      "INSERT INTO storage_samples (placement_id, student_id, pool, used_bytes, quota_bytes, ts) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(placementId, studentId, pool, used, quota, ts);
}

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  stats = await import("../src/lib/stats");
  const d = dbmod.db();
  d.prepare("INSERT INTO nodes (id, name, online, created_at) VALUES (1, 'node-a', 1, 0)").run();
  mkLabPlacement(1, "bio", 1, 50001);
  d.prepare("INSERT INTO students (id, username, name, linux_uid, created_at, updated_at) VALUES (1, 'alice', 'Alice A.', 10000, 0, 0)").run();
  d.prepare("INSERT INTO students (id, username, name, linux_uid, created_at, updated_at) VALUES (2, 'bob', 'Bob B.', 10001, 0, 0)").run();
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

function setScanned(name: string, at: number) {
  dbmod.db().prepare("UPDATE lab_placements SET usage_scanned_at = ? WHERE lab_id = (SELECT id FROM labs WHERE name = ?)").run(at, name);
}

function findLab(name: string) {
  return stats.buildStats().find((n) => n.node === "node-a")!.labs.find((l) => l.labName === name)!;
}

describe("buildStats", () => {
  it("groups latest per-student and placement-level usage by node and lab", () => {
    sample(1, 1, "fast", 100, 100);
    sample(1, 1, "fast", 150, 200);
    sample(1, 2, "fast", 80, 200);
    sample(1, null, "rootfs", 300, 200);
    sample(1, null, "fast", 500, 200, 2000);
    sample(1, null, "cold", 200, 200, 3000);

    const nodes = stats.buildStats();
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.node).toBe("node-a");
    expect(node.totalRootfsBytes).toBe(300);

    const lab = node.labs.find((l) => l.labName === "bio")!;
    expect(lab.image).toBe("img-x");
    expect(lab.placementId).toBe(1);
    expect(lab.students.map((s) => s.username)).toEqual(["alice", "bob"]);
    expect(lab.students[0].fast).toBe(150);
    expect(lab.students[1].fast).toBe(80);
    expect(lab.live.rootfs).toBe(300);
    expect(lab.live.fast).toEqual({ used: 500, quota: 2000 });
    expect(lab.live.cold).toEqual({ used: 200, quota: 3000 });
    expect(lab.liveUpdatedAt).toBe(200);
    expect(lab.liveStale).toBe(true);
  });
});

describe("scanPending", () => {
  beforeAll(() => {
    const cases = [[10, "queued"], [11, "sent"], [12, "fresh-ingest"], [13, "landed"], [14, "expired"], [15, "failed"], [16, "noscan"]] as const;
    cases.forEach(([id, name]) => mkLabPlacement(id, name, id, 50000 + id));
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
    setScanned("fresh-ingest", created - 1000);
    expect(findLab("fresh-ingest").scanPending).toBe(true);
  });

  it("flips false once usage_scanned_at advances past the request (data landed)", () => {
    const created = Date.now();
    scanTask("node-a", "landed", "ok", created);
    setScanned("landed", created + 1000);
    expect(findLab("landed").scanPending).toBe(false);
  });

  it("does not keep an ok task pending forever if the heartbeat never lands", () => {
    scanTask("node-a", "expired", "ok", Date.now() - 20 * 60 * 1000);
    expect(findLab("expired").scanPending).toBe(false);
  });

  it("is false for a failed scan and when there is no scan task", () => {
    scanTask("node-a", "failed", "failed", Date.now());
    expect(findLab("failed").scanPending).toBe(false);
    expect(findLab("noscan").scanPending).toBe(false);
  });

  it("tracks only the latest task per lab", () => {
    scanTask("node-a", "noscan", "ok", Date.now() - 5000);
    setScanned("noscan", Date.now() - 4000);
    scanTask("node-a", "noscan", "queued", Date.now());
    expect(findLab("noscan").scanPending).toBe(true);
  });
});

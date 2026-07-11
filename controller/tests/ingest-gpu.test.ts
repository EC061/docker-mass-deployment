import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-ingest-gpu-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");
let ingest: typeof import("../src/lib/ingest");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  ingest = await import("../src/lib/ingest");
  const d = dbmod.db();
  // A node hosting one lab placement.
  d.prepare("INSERT INTO nodes (name, allowed, online, created_at) VALUES ('gpu-1', 1, 1, 0)").run();
  const nodeId = (d.prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
  d.prepare("INSERT INTO labs (name, created_at, updated_at) VALUES ('bio', 0, 0)").run();
  const labId = (d.prepare("SELECT id FROM labs WHERE name='bio'").get() as any).id;
  d.prepare(
    `INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, ssh_port, image, state, created_at, updated_at)
     VALUES (?, ?, 1, 40000, 'custom-ssh', 'active', 0, 0)`,
  ).run(labId, nodeId);
  d.prepare(
    `INSERT INTO students (username, email, linux_uid, created_at, updated_at)
     VALUES ('alice', 'alice@uga.edu', 10042, 0, 0)`,
  ).run();
  const studentId = (d.prepare("SELECT id FROM students WHERE username='alice'").get() as any).id;
  d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, 0)")
    .run(labId, studentId);
});

describe("GPU telemetry ingest (Phase 9)", () => {
  it("attributes a managed process to its placement and leaves host processes unattributed", () => {
    ingest.ingestTelemetry("gpu-1", {
      gpu_processes: [
        { pid: 100, lab: "bio", user: "alice", vram_bytes: 1024, util: 0, managed: true,
          cmd: "/usr/bin/python3 train.py", started_at: 1_700_000_000_000 },
        { pid: 200, lab: null, user: null, vram_bytes: 2048, util: 50, managed: false }, // host proc
        { pid: 300, lab: "ghost", user: "x", vram_bytes: 1, util: 0 }, // lab not placed here
      ],
    });
    const d = dbmod.db();
    const placementId = (
      d.prepare("SELECT id FROM lab_placements WHERE ssh_port=40000").get() as any
    ).id;

    const managed = d.prepare("SELECT * FROM gpu_snapshot WHERE node='gpu-1' AND pid=100").get() as any;
    expect(managed.lab).toBe("bio");
    expect(managed.placement_id).toBe(placementId);
    expect(managed.cmd).toBe("/usr/bin/python3 train.py");
    expect(managed.started_at).toBe(1_700_000_000_000);

    const host = d.prepare("SELECT * FROM gpu_snapshot WHERE node='gpu-1' AND pid=200").get() as any;
    expect(host.lab).toBeNull();
    expect(host.placement_id).toBeNull();

    // A lab name with no placement on this node resolves to no placement.
    const ghost = d.prepare("SELECT * FROM gpu_snapshot WHERE node='gpu-1' AND pid=300").get() as any;
    expect(ghost.placement_id).toBeNull();
  });

  it("replaces the prior snapshot for the node on each telemetry frame", () => {
    ingest.ingestTelemetry("gpu-1", { gpu_processes: [{ pid: 999, lab: "bio", vram_bytes: 1, util: 1 }] });
    const rows = dbmod.db().prepare("SELECT pid FROM gpu_snapshot WHERE node='gpu-1'").all() as any[];
    expect(rows.map((r) => r.pid)).toEqual([999]);
  });

  it("records a deduplicated automatic alert when a user exceeds 50% of an assigned quota", () => {
    ingest.ingestTelemetry("gpu-1", {
      storage: [{
        lab: "bio", user: "alice", tier: "fast", used_bytes: 51, quota_bytes: 100,
        available_bytes: 49,
      }],
    });
    expect(dbmod.db().prepare("SELECT pct, pool FROM student_quota_alerts").all())
      .toEqual([{ pct: 51, pool: "fast" }]);
    ingest.ingestTelemetry("gpu-1", {
      storage: [{
        lab: "bio", user: "alice", tier: "fast", used_bytes: 60, quota_bytes: 100,
        available_bytes: 40,
      }],
    });
    expect((dbmod.db().prepare("SELECT COUNT(*) AS n FROM student_quota_alerts").get() as any).n).toBe(1);
  });
});

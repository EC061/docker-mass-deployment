import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-p2-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let db: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");
let ingest: typeof import("../src/lib/ingest");

beforeAll(async () => {
  db = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
  ingest = await import("../src/lib/ingest");

  // Seed: one node, one lab, one student member named alice.
  const now = Date.now();
  db.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, ?)").run(now);
  const nodeId = (db.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
  db.db()
    .prepare(
      `INSERT INTO labs (name, node_id, fast_quota_bytes, slow_quota_bytes, image, created_at)
       VALUES ('bio', ?, 2199023255552, 3298534883328, 'custom-ssh', ?)`,
    )
    .run(nodeId, now);
  const labId = (db.db().prepare("SELECT id FROM labs WHERE name='bio'").get() as any).id;
  db.db()
    .prepare("INSERT INTO students (username, email, created_at) VALUES ('alice', 'a@uga.edu', ?)")
    .run(now);
  const studentId = (db.db().prepare("SELECT id FROM students WHERE username='alice'").get() as any).id;
  db.db()
    .prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)")
    .run(labId, studentId, now);
});

describe("settings", () => {
  it("roundtrips and falls back to defaults", () => {
    expect(settings.getSetting("oldFileThresholdDays")).toBe(30);
    settings.setSetting("oldFileThresholdDays", 14);
    expect(settings.getSetting("oldFileThresholdDays")).toBe(14);
  });

  it("nextSshPort skips ports already assigned to labs", () => {
    settings.setSetting("sshPortStart", 50000);
    settings.setSetting("sshPortEnd", 50010);
    db.db().prepare("UPDATE labs SET ssh_port = 50000 WHERE name='bio'").run();
    expect(settings.nextSshPort()).toBe(50001);
  });
});

describe("telemetry ingestion", () => {
  it("maps datasets to lab- and student-level storage samples", () => {
    ingest.ingestTelemetry("gpu-1", {
      pools: [{ name: "fast", free: 100 }],
      datasets: [
        { pool: "fast", dataset: "fast/labs/bio", used_bytes: 1000, quota_bytes: 2199023255552 },
        { pool: "fast", dataset: "fast/labs/bio/shared", used_bytes: 500, quota_bytes: null },
        { pool: "fast", dataset: "fast/labs/bio/users/alice", used_bytes: 250, quota_bytes: null },
        { pool: "fast", dataset: "fast/labs/bio/users/ghost", used_bytes: 999, quota_bytes: null },
      ],
      gpu_processes: [{ pid: 42, vram_bytes: 1048576, util: 0, user: "alice" }],
    });

    const labSample = db
      .db()
      .prepare("SELECT * FROM storage_samples WHERE lab_id=(SELECT id FROM labs WHERE name='bio') AND student_id IS NULL")
      .get() as any;
    expect(labSample.used_bytes).toBe(1000);

    const aliceSample = db
      .db()
      .prepare(
        "SELECT * FROM storage_samples WHERE student_id=(SELECT id FROM students WHERE username='alice')",
      )
      .get() as any;
    expect(aliceSample.used_bytes).toBe(250);

    // 'shared' and unknown-user 'ghost' are not sampled.
    const total = db.db().prepare("SELECT COUNT(*) AS n FROM storage_samples").get() as any;
    expect(total.n).toBe(2);

    // GPU snapshot replaced for the node.
    const gpu = db.db().prepare("SELECT * FROM gpu_snapshot WHERE node='gpu-1'").all() as any[];
    expect(gpu.length).toBe(1);
    expect(gpu[0].pid).toBe(42);
  });

  it("stores old-file scan results mapped to students", () => {
    ingest.storeOldfileScan({
      lab: "bio",
      results: [
        { scope: "lab_fast_shared", username: null, atime_count: 3, atime_bytes: 30, mtime_count: 1, mtime_bytes: 10, oldest: 1 },
        { scope: "user_scratch", username: "alice", atime_count: 5, atime_bytes: 50, mtime_count: 2, mtime_bytes: 20, oldest: 2 },
      ],
    });
    const rows = db.db().prepare("SELECT * FROM oldfile_scans WHERE lab_id=(SELECT id FROM labs WHERE name='bio')").all() as any[];
    expect(rows.length).toBe(2);
    const aliceRow = rows.find((r) => r.student_id !== null);
    expect(aliceRow.atime_count).toBe(5);
  });

  it("records per-lab usage-scan time and only moves it forward", () => {
    ingest.ingestTelemetry("gpu-1", {
      datasets: [],
      usage_scans: [{ lab: "bio", scanned_at: 5000 }],
      gpu_processes: [],
    });
    const after = db.db().prepare("SELECT usage_scanned_at FROM labs WHERE name='bio'").get() as any;
    expect(after.usage_scanned_at).toBe(5000);

    // An older (stale) report must not roll the timestamp back.
    ingest.ingestTelemetry("gpu-1", {
      datasets: [],
      usage_scans: [{ lab: "bio", scanned_at: 1000 }],
      gpu_processes: [],
    });
    const stale = db.db().prepare("SELECT usage_scanned_at FROM labs WHERE name='bio'").get() as any;
    expect(stale.usage_scanned_at).toBe(5000);
  });

  it("stores docker-pool samples (installed software) without raising a PI quota alert", () => {
    ingest.ingestTelemetry("gpu-1", {
      pools: [{ name: "fast", free: 100 }],
      datasets: [
        // lab-level docker is over 90% of its quota, but the docker pool must never alert.
        { pool: "docker", dataset: "docker/labs/bio", used_bytes: 95, quota_bytes: 100 },
        { pool: "docker", dataset: "docker/labs/bio/users/alice", used_bytes: 40, quota_bytes: null },
      ],
      gpu_processes: [],
    });
    const dockerSamples = db
      .db()
      .prepare("SELECT * FROM storage_samples WHERE pool='docker'")
      .all() as any[];
    expect(dockerSamples.length).toBe(2);
    const alerts = db.db().prepare("SELECT * FROM quota_alerts WHERE pool='docker'").all() as any[];
    expect(alerts.length).toBe(0);
  });
});

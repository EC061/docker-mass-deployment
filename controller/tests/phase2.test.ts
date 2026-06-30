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

  // Seed: one node, one logical lab placed on it, one student member named alice.
  const now = Date.now();
  db.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, ?)").run(now);
  const nodeId = (db.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
  db.db().prepare("INSERT INTO labs (name, created_at, updated_at) VALUES ('bio', ?, ?)").run(now, now);
  const labId = (db.db().prepare("SELECT id FROM labs WHERE name='bio'").get() as any).id;
  db.db()
    .prepare(
      `INSERT INTO lab_placements (lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
       VALUES (?, ?, 2199023255552, 3298534883328, 2222, 'custom-ssh', 'active', ?, ?)`,
    )
    .run(labId, nodeId, now, now);
  db.db()
    .prepare("INSERT INTO students (username, email, linux_uid, created_at, updated_at) VALUES ('alice', 'a@uga.edu', 10000, ?, ?)")
    .run(now, now);
  const studentId = (db.db().prepare("SELECT id FROM students WHERE username='alice'").get() as any).id;
  db.db()
    .prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)")
    .run(labId, studentId, now);
});

describe("settings", () => {
  it("roundtrips and falls back to defaults", () => {
    expect(settings.getSetting("usageScanHour")).toBe(0); // midnight default
    settings.setSetting("usageScanHour", 5);
    expect(settings.getSetting("usageScanHour")).toBe(5);
  });
});

describe("telemetry ingestion", () => {
  it("maps explicit lab/user/tier rows to storage samples", () => {
    ingest.ingestTelemetry("gpu-1", {
      pools: [{ name: "fast", free: 100 }],
      storage: [
        { lab: "bio", user: null, tier: "fast", used_bytes: 1000, quota_bytes: 2199023255552 },
        { lab: "bio", user: "alice", tier: "fast", used_bytes: 250, quota_bytes: null },
        { lab: "bio", user: "ghost", tier: "fast", used_bytes: 999, quota_bytes: null },
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

    // Unknown-user 'ghost' is not sampled.
    const total = db.db().prepare("SELECT COUNT(*) AS n FROM storage_samples").get() as any;
    expect(total.n).toBe(2);

    // GPU snapshot replaced for the node.
    const gpu = db.db().prepare("SELECT * FROM gpu_snapshot WHERE node='gpu-1'").all() as any[];
    expect(gpu.length).toBe(1);
    expect(gpu[0].pid).toBe(42);
  });

  it("records per-lab usage-scan time and only moves it forward", () => {
    ingest.ingestTelemetry("gpu-1", {
      storage: [],
      usage_scans: [{ lab: "bio", scanned_at: 5000 }],
      gpu_processes: [],
    });
    const after = db.db().prepare("SELECT usage_scanned_at FROM lab_placements WHERE lab_id=(SELECT id FROM labs WHERE name='bio')").get() as any;
    expect(after.usage_scanned_at).toBe(5000);

    // An older (stale) report must not roll the timestamp back.
    ingest.ingestTelemetry("gpu-1", {
      storage: [],
      usage_scans: [{ lab: "bio", scanned_at: 1000 }],
      gpu_processes: [],
    });
    const stale = db.db().prepare("SELECT usage_scanned_at FROM lab_placements WHERE lab_id=(SELECT id FROM labs WHERE name='bio')").get() as any;
    expect(stale.usage_scanned_at).toBe(5000);
  });

  it("stores rootfs samples without raising a PI quota alert", () => {
    ingest.ingestTelemetry("gpu-1", {
      pools: [{ name: "fast", free: 100 }],
      storage: [
        { lab: "bio", user: null, tier: "rootfs", used_bytes: 95, quota_bytes: 100 },
        { lab: "bio", user: "alice", tier: "rootfs", used_bytes: 40, quota_bytes: null },
      ],
      gpu_processes: [],
    });
    const rootfsSamples = db
      .db()
      .prepare("SELECT * FROM storage_samples WHERE pool='rootfs'")
      .all() as any[];
    expect(rootfsSamples.length).toBe(2);
    const alerts = db.db().prepare("SELECT * FROM quota_alerts WHERE pool='rootfs'").all() as any[];
    expect(alerts.length).toBe(0);
  });

  it("lets a changed scan-derived value bypass the 5-min throttle (so a fresh scan lands)", () => {
    const rootfsRows = () =>
      (db.db().prepare(
        "SELECT COUNT(*) AS n FROM storage_samples WHERE pool='rootfs' AND lab_id=(SELECT id FROM labs WHERE name='bio') AND student_id IS NULL",
      ).get() as any).n as number;
    const fastRows = () =>
      (db.db().prepare(
        "SELECT COUNT(*) AS n FROM storage_samples WHERE pool='fast' AND lab_id=(SELECT id FROM labs WHERE name='bio') AND student_id IS NULL",
      ).get() as any).n as number;

    const rootfsBefore = rootfsRows();
    const fastBefore = fastRows();

    // A changed docker (writable-layer) value reported moments later must store, even though the
    // previous sample is well within the throttle window — this is the post-scan refresh.
    ingest.ingestTelemetry("gpu-1", {
      storage: [{ lab: "bio", user: null, tier: "rootfs", used_bytes: 12345, quota_bytes: null }],
      gpu_processes: [],
    });
    expect(rootfsRows()).toBe(rootfsBefore + 1);

    // Re-reporting the same value (the agent re-sends its cached number every heartbeat) must NOT
    // create another row — store on change only, so the series doesn't bloat between scans.
    ingest.ingestTelemetry("gpu-1", {
      storage: [{ lab: "bio", user: null, tier: "rootfs", used_bytes: 12345, quota_bytes: null }],
      gpu_processes: [],
    });
    expect(rootfsRows()).toBe(rootfsBefore + 1);

    // A live lab-level fast value (ZFS metadata) that drifts within the window stays throttled.
    ingest.ingestTelemetry("gpu-1", {
      storage: [{ lab: "bio", user: null, tier: "fast", used_bytes: 4242, quota_bytes: 2199023255552 }],
      gpu_processes: [],
    });
    expect(fastRows()).toBe(fastBefore);
  });
});

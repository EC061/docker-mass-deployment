import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-gpu-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");
let gpu: typeof import("../src/lib/gpu");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  gpu = await import("../src/lib/gpu");
});

describe("GPU kill stats grouping", () => {
  const ev = (o: Partial<import("../src/lib/gpu").GpuEventRow>) => ({
    id: 0,
    node: "gpu-1",
    pid: 1,
    user: null,
    lab: null,
    vram_bytes: null,
    state: "killed",
    ts: 0,
    cmd: null,
    idle_s: null,
    ...o,
  });

  it("groups lab -> student with counts, worst offenders first, events newest first", () => {
    const stats = gpu.groupGpuEvents([
      ev({ id: 1, lab: "bio", user: "alice", state: "warned", ts: 10 }),
      ev({ id: 2, lab: "bio", user: "alice", state: "killed", ts: 20, cmd: "python train.py", idle_s: 1800 }),
      ev({ id: 3, lab: "bio", user: "bob", state: "warned", ts: 30 }),
      ev({ id: 4, lab: "chem", user: "carol", state: "killed", ts: 40 }),
      ev({ id: 5, lab: "chem", user: "carol", state: "killed", ts: 50 }),
      ev({ id: 6, lab: null, user: null, state: "killed", ts: 60 }),
    ]);

    // chem (2 kills) > bio (1 kill, 2 warns) > unattributed (1 kill, 0 warns).
    expect(stats.map((l) => l.lab)).toEqual(["chem", "bio", null]);
    expect(stats[0]).toMatchObject({ killed: 2, warned: 0 });

    const bio = stats[1];
    expect(bio).toMatchObject({ killed: 1, warned: 2 });
    // alice (1 kill) ranks above bob (0 kills, 1 warn).
    expect(bio.students.map((s) => s.user)).toEqual(["alice", "bob"]);
    expect(bio.students[0]).toMatchObject({ killed: 1, warned: 1, lastTs: 20 });
    // Per-student detail rows are newest first and carry the forensics fields.
    expect(bio.students[0].events.map((e) => e.id)).toEqual([2, 1]);
    expect(bio.students[0].events[0]).toMatchObject({ cmd: "python train.py", idle_s: 1800 });
  });

  it("stores and reads back cmd/idle_s on ingested events", () => {
    const d = dbmod.db();
    d.prepare(
      `INSERT INTO gpu_events (node, pid, user, lab, state, ts, cmd, idle_s)
       VALUES ('gpu-1', 7, 'alice', 'bio', 'killed', 5, '/usr/bin/python3 train.py', 2400)`,
    ).run();
    const rows = gpu.recentGpuEvents();
    expect(rows[0]).toMatchObject({ cmd: "/usr/bin/python3 train.py", idle_s: 2400 });
    d.prepare("DELETE FROM gpu_events").run();
  });
});

describe("GPU event history", () => {
  it("clears events, preserves the live snapshot, and records an audit entry", () => {
    const d = dbmod.db();
    d.prepare(
      "INSERT INTO gpu_snapshot (node, pid, ts) VALUES ('gpu-1', 42, 1)",
    ).run();
    d.prepare(
      "INSERT INTO gpu_events (node, pid, state, ts) VALUES ('gpu-1', 42, 'warned', 1)",
    ).run();
    d.prepare(
      "INSERT INTO gpu_events (node, pid, state, ts) VALUES ('gpu-1', 42, 'killed', 2)",
    ).run();

    expect(gpu.clearGpuEvents("admin@example.com")).toBe(2);
    expect(d.prepare("SELECT COUNT(*) AS n FROM gpu_events").get()).toMatchObject({ n: 0 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM gpu_snapshot").get()).toMatchObject({ n: 1 });
    expect(
      d.prepare("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get(),
    ).toMatchObject({
      actor: "admin@example.com",
      action: "gpu.events.clear",
      detail: "2 event(s)",
    });
  });

  it("deletes a single event, leaves the rest, and records an audit entry", () => {
    const d = dbmod.db();
    d.prepare("INSERT INTO gpu_events (node, pid, state, ts) VALUES ('gpu-1', 1, 'warned', 1)").run();
    d.prepare("INSERT INTO gpu_events (node, pid, state, ts) VALUES ('gpu-1', 2, 'killed', 2)").run();
    const victim = d.prepare("SELECT id FROM gpu_events WHERE pid = 1").get() as { id: number };

    gpu.deleteGpuEvent(victim.id, "admin@example.com");

    const remaining = gpu.recentGpuEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pid).toBe(2);
    expect(
      d.prepare("SELECT actor, action, target FROM audit_log ORDER BY id DESC LIMIT 1").get(),
    ).toMatchObject({
      actor: "admin@example.com",
      action: "gpu.event.delete",
      target: String(victim.id),
    });
    d.prepare("DELETE FROM gpu_events").run();
  });

  it("throws when the event does not exist", () => {
    expect(() => gpu.deleteGpuEvent(999999, "admin@example.com")).toThrow(/not found/);
  });
});

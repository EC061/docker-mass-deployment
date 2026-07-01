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
});

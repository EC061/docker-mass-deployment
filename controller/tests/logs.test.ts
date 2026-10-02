import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeTask } from "../src/lib/task-description";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "lab-ctl-logs-")), "controller.db");
let dbmod: typeof import("../src/lib/db");
let logs: typeof import("../src/lib/logs");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  logs = await import("../src/lib/logs");
});

beforeEach(() => {
  dbmod.db().exec("DELETE FROM logs; DELETE FROM task_log;");
});

function task(id: string, node: string, action: string, params = "{}", error: string | null = null) {
  dbmod.db().prepare(
    `INSERT INTO task_log (task_uuid, node, action, params, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(id, node, action, params, error);
  return { node, action, params };
}

function entry(id: string | null, msg = "task ok", node: string | null = null, ts = 1, source = "task") {
  dbmod.db().prepare(
    "INSERT INTO logs (ts, node, level, source, task_id, msg) VALUES (?, ?, 'INFO', ?, ?, ?)",
  ).run(ts, node, source, id, msg);
}

describe("descriptive task logs", () => {
  it("recovers old completion context without rewriting historical records", () => {
    task("policy", "geass", "gpu.policy.update", '{"enabled":true,"idle_minutes":30}');
    entry("policy");
    expect(logs.listLogs()[0]).toMatchObject({
      node: "geass", task_action: "gpu.policy.update",
      msg: "Update GPU idle policy · enabled · idle 30 min on geass — completed",
    });
    expect(dbmod.db().prepare("SELECT node, msg FROM logs").get()).toEqual({ node: null, msg: "task ok" });
    expect(logs.logNodes()).toEqual(["geass"]);
  });

  it("applies recovered node and action filters before the result limit", () => {
    task("policy", "geass", "gpu.policy.update");
    entry("policy");
    entry(null, "unrelated recent log", "gpu-2", 2);
    expect(logs.listLogs({ node: "geass", q: "gpu.policy.update" }, { limit: 1 }))
      .toEqual([expect.objectContaining({ task_id: "policy" })]);
    for (const q of ["geass", "Update GPU idle policy", "policy"]) {
      expect(logs.listLogs({ q })).toEqual([expect.objectContaining({ task_id: "policy" })]);
    }
  });

  it("shows and searches historical lab and student context and preserves failure reasons", () => {
    task("student", "gpu-1", "student.add", '{"lab":"biology","username":"alice"}', "Container is stopped");
    entry("student", "task failed");
    for (const q of ["biology", "alice"]) {
      expect(logs.listLogs({ q })[0]).toMatchObject({
        lab: "biology", user: "alice",
        msg: "Provision student access · lab biology · student alice on gpu-1 — failed: Container is stopped",
      });
    }
  });

  it("records success and failure even without output, with authenticated task context", () => {
    const success = task("ok", "geass", "node.check");
    const failed = task("failed", "gpu-2", "student.add", '{"lab":"bio","username":"bob"}');
    logs.recordTaskResultLog(success, { type: "result", id: "ok", ok: true });
    logs.recordTaskResultLog(failed, { type: "result", id: "failed", ok: false, error: "Disk full" });
    expect(logs.listLogs({ task: "ok" })[0]).toMatchObject({
      node: "geass", level: "INFO", msg: "Check node health on geass — completed", detail: null,
    });
    expect(logs.listLogs({ level: "ERROR" })[0]).toMatchObject({
      node: "gpu-2", lab: "bio", user: "bob", task_id: "failed",
      msg: "Provision student access · lab bio · student bob on gpu-2 — failed: Disk full",
    });
  });

  it("retains output and streamed messages alongside the task action", () => {
    const context = task("check", "geass", "node.check");
    entry("check", "Checking NVIDIA driver", "geass", 1, "agent");
    logs.recordTaskResultLog(context, { type: "result", id: "check", ok: true, logs: "All checks passed\n" });
    const rows = logs.listLogs({ task: "check" }, { chronological: true, limit: -1 });
    expect(rows[0]).toMatchObject({ msg: "Checking NVIDIA driver", task_action: "node.check" });
    expect(rows[1].detail).toBe("All checks passed\n");
  });

  it("does not attach another node's task context to a streamed log", () => {
    task("foreign", "gpu-1", "student.add", '{"username":"alice"}');
    entry("foreign", "task ok", "gpu-2");
    expect(logs.listLogs()[0]).toMatchObject({ node: "gpu-2", msg: "task ok", task_action: null, user: null });
    expect(logs.listLogs({ node: "gpu-1" })).toEqual([]);
    expect(logs.logNodes()).toEqual(["gpu-2"]);
  });

  it("keeps unlinked and non-task logs and tolerates malformed historical params", () => {
    task("bad", "geass", "node.check", "{broken");
    entry("bad");
    entry("deleted", "task ok", null, 2);
    entry(null, "Pool unhealthy", "gpu-2", 3, "scrub");
    expect(logs.listLogs().map((row) => row.msg)).toEqual([
      "Pool unhealthy", "task ok", "Check node health on geass — completed",
    ]);
    expect(logs.listLogs({ q: "missing" })).toEqual([]);
    expect(describeTask("future.action", "null")).toBe("future.action");
    expect(describeTask("node.check", "[]")).toBe("Check node health");
  });

  it("never copies arbitrary parameters or credentials into a log summary", () => {
    const context = task("add", "geass", "student.add", JSON.stringify({
      lab: "bio", username: "alice", password: "private-password",
      nested: { token: "private-token" }, unexpected: "private-extra",
    }));
    logs.recordTaskResultLog(context, { type: "result", id: "add", ok: true });
    const raw = dbmod.db().prepare("SELECT * FROM logs").get();
    expect(JSON.stringify(raw)).not.toContain("private-");
    expect(logs.listLogs({ q: "private-password" })).toEqual([]);
  });
});

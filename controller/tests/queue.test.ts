import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-queue-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Real honker queue (writes queue.db next to controller.db).
let dbmod: typeof import("../src/lib/db");
let queue: typeof import("../src/lib/queue");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  queue = await import("../src/lib/queue");
});

describe("enqueueTask", () => {
  it("returns a task frame and mirrors it into task_log as queued", () => {
    const frame = queue.enqueueTask("gpu-1", "lab.create", { lab: "bio" }, "admin");
    expect(frame.type).toBe("task");
    expect(frame.action).toBe("lab.create");
    expect(frame.params).toEqual({ lab: "bio" });
    expect(frame.requested_by).toBe("admin");
    expect(typeof frame.id).toBe("string");

    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("queued");
    expect(row.node).toBe("gpu-1");
    expect(row.action).toBe("lab.create");
    expect(JSON.parse(row.params)).toEqual({ lab: "bio" });
    expect(row.requested_by).toBe("admin");
  });

  it("generates a unique id per task", () => {
    const a = queue.enqueueTask("gpu-1", "node.scrub");
    const b = queue.enqueueTask("gpu-1", "node.scrub");
    expect(a.id).not.toBe(b.id);
  });
});

describe("claim / ack", () => {
  it("claims a queued task for the destination node, then acks it (no redelivery)", () => {
    const frame = queue.enqueueTask("worker-node", "lab.set_quota", { lab: "x" });
    const claimed = queue.claimTask("worker-node", "w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.frame.id).toBe(frame.id);
    expect(claimed!.frame.params).toEqual({ lab: "x" });
    expect(typeof claimed!.jobId).toBe("number");
    // ack must pass the claiming worker id; once acked the task is gone.
    queue.ackTask("worker-node", claimed!.jobId, "w1");
    expect(queue.claimTask("worker-node", "w1")).toBeNull();
  });

  it("does not deliver another node's tasks", () => {
    queue.enqueueTask("node-a", "lab.create");
    expect(queue.claimTask("node-b", "w1")).toBeNull();
  });

  it("returns null when the queue is empty", () => {
    expect(queue.claimTask("empty-node", "w1")).toBeNull();
  });

  it("retryTask makes the job claimable again without throwing", () => {
    queue.enqueueTask("retry-node", "node.scrub");
    const claimed = queue.claimTask("retry-node", "w1")!;
    expect(() => queue.retryTask("retry-node", claimed.jobId, "w1", "send failed")).not.toThrow();
  });
});

describe("markTaskState", () => {
  it("transitions task_log state and stores the result", () => {
    const frame = queue.enqueueTask("gpu-1", "lab.create", { lab: "y" });
    queue.markTaskState(frame.id, "ok", { container: "abc" });
    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("ok");
    expect(JSON.parse(row.result)).toEqual({ container: "abc" });
    expect(row.error).toBeNull();
  });

  it("stores an error string on failure", () => {
    const frame = queue.enqueueTask("gpu-1", "lab.create");
    queue.markTaskState(frame.id, "failed", undefined, "boom");
    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("failed");
    expect(row.result).toBeNull();
    expect(row.error).toBe("boom");
  });
});

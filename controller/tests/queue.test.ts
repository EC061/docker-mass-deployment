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

describe("getTask", () => {
  it("returns the full task row by uuid, or null for an unknown id", () => {
    const frame = queue.enqueueTask("gpu-1", "student.add", { username: "alice" }, "admin");
    const row = queue.getTask(frame.id);
    expect(row).not.toBeNull();
    expect(row!.action).toBe("student.add");
    expect(row!.node).toBe("gpu-1");
    expect(row!.requested_by).toBe("admin");
    expect(JSON.parse(row!.params!)).toEqual({ username: "alice" });
    expect(queue.getTask("no-such-uuid")).toBeNull();
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
    expect(queue.markTaskState("gpu-1", frame.id, "ok", { container: "abc" })).toBe(true);
    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("ok");
    expect(JSON.parse(row.result)).toEqual({ container: "abc" });
    expect(row.error).toBeNull();
  });

  it("stores an error string on failure", () => {
    const frame = queue.enqueueTask("gpu-1", "lab.create");
    expect(queue.markTaskState("gpu-1", frame.id, "failed", undefined, "boom")).toBe(true);
    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("failed");
    expect(row.result).toBeNull();
    expect(row.error).toBe("boom");
  });

  it("refuses to mutate a task that belongs to a different node (H-03)", () => {
    const frame = queue.enqueueTask("node-owner", "student.add", { username: "alice" });
    // A spoofing agent ("node-evil") tries to complete node-owner's task.
    expect(queue.markTaskState("node-evil", frame.id, "ok", { hijacked: true })).toBe(false);
    const row = dbmod.db().prepare("SELECT * FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.state).toBe("queued"); // untouched
    expect(row.result).toBeNull();
  });
});

describe("secret handling (Phase 8)", () => {
  it("redactSecrets masks credential keys but keeps ordinary fields", () => {
    const out = queue.redactSecrets({
      lab: "bio",
      username: "alice",
      password: "hunter2",
      nested: { token: "abc", count: 3 },
    }) as any;
    expect(out.lab).toBe("bio");
    expect(out.username).toBe("alice");
    expect(out.password).not.toBe("hunter2");
    expect(out.nested.token).not.toBe("abc");
    expect(out.nested.count).toBe(3);
  });

  it("stores REDACTED params in task_log but delivers the real password to the node", () => {
    const frame = queue.enqueueTask("sec-node", "student.add", {
      username: "bob",
      password: "s3cret-pw",
    });
    // The long-lived (backed-up) task_log must not contain the cleartext password.
    const row = dbmod.db().prepare("SELECT params FROM task_log WHERE task_uuid = ?").get(frame.id) as any;
    expect(row.params).not.toContain("s3cret-pw");
    expect(JSON.parse(row.params).username).toBe("bob");
    // The queue payload is encrypted at rest, but claim decrypts it so the agent gets the password.
    const claimed = queue.claimTask("sec-node", "w1")!;
    expect(claimed.frame.params).toEqual({ username: "bob", password: "s3cret-pw" });
    queue.ackTask("sec-node", claimed.jobId, "w1");
  });
});

describe("durability fields (Phase 8)", () => {
  it("markTaskReceived sets received_at once; bumpAttempts increments", () => {
    const frame = queue.enqueueTask("dur-node", "lab.create", { lab: "z" });
    let row = queue.getTask(frame.id)!;
    expect(row.received_at).toBeNull();
    expect(row.attempts).toBe(0);

    queue.bumpAttempts("dur-node", frame.id);
    queue.markTaskReceived("dur-node", frame.id);
    row = queue.getTask(frame.id)!;
    expect(row.attempts).toBe(1);
    const first = row.received_at;
    expect(typeof first).toBe("number");

    // received_at is set only once (subsequent receipts don't overwrite it).
    queue.markTaskReceived("dur-node", frame.id);
    expect(queue.getTask(frame.id)!.received_at).toBe(first);
  });

  it("markTaskState records the cached (idempotent replay) flag", () => {
    const frame = queue.enqueueTask("dur-node", "node.scrub");
    queue.markTaskState("dur-node", frame.id, "ok", { ok: true }, undefined, true);
    expect(queue.getTask(frame.id)!.result_cached).toBe(1);
  });
});

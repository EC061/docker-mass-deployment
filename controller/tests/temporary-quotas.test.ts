import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "temporary-quota-")), "db.sqlite");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const tasks = new Map<string, { state: string; result?: string; error?: string }>();
const enqueueTask = vi.fn(() => {
  const id = `task-${tasks.size}`;
  tasks.set(id, { state: "queued" });
  return { id };
});
vi.mock("../src/lib/queue", () => ({ enqueueTask, getTask: (id: string) => tasks.get(id) }));
const alertAdmins = vi.fn(async () => {});
vi.mock("../src/lib/alerts", () => ({ alertAdmins }));
let quotas: typeof import("../src/lib/temporary-quotas");
let placements: typeof import("../src/lib/placements");
let db: ReturnType<typeof import("../src/lib/db")["db"]>;
const DAY = 86400000;

beforeAll(async () => {
  db = (await import("../src/lib/db")).db();
  quotas = await import("../src/lib/temporary-quotas");
  placements = await import("../src/lib/placements");
  db.prepare("INSERT INTO nodes (id, name, online, created_at) VALUES (1, 'node-a', 1, 0)").run();
  db.prepare("INSERT INTO labs (id, name, created_at) VALUES (1, 'biology', 0)").run();
});
beforeEach(() => {
  db.prepare("DELETE FROM lab_placements").run();
  db.prepare(`INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes,
    ssh_port, image, state, created_at, updated_at) VALUES (1, 1, 1, 1000, 2000, 2200, 'image', 'active', 0, 0)`).run();
  tasks.clear();
  enqueueTask.mockClear();
  alertAdmins.mockClear();
});

it.each([7, 14, 3])("restores both original limits after %i days, not before", (days) => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000, coldQuotaBytes: 4000 }, days, "admin", 0);
  expect(quotas.temporaryQuota(1)).toMatchObject({ original_fast: 1000, original_cold: 2000, expires_at: days * DAY });
  quotas.scheduleTemporaryQuotas(days * DAY - 1);
  expect(enqueueTask).toHaveBeenCalledTimes(1);
  quotas.scheduleTemporaryQuotas(days * DAY);
  expect(enqueueTask).toHaveBeenLastCalledWith("node-a", "lab.set_quota", {
    lab: "biology", restore_floor: true, fast_quota_bytes: 1000, slow_quota_bytes: 2000,
  }, "temporary-quota-expiry");
  quotas.scheduleTemporaryQuotas(days * DAY + 1);
  expect(enqueueTask).toHaveBeenCalledTimes(2);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "ok", result: JSON.stringify({
    fast: { used_bytes: 500, quota_bytes: 1000 }, slow: { used_bytes: 900, quota_bytes: 2000 },
  }) });
  quotas.scheduleTemporaryQuotas(days * DAY + 2);
  expect(quotas.temporaryQuota(1)?.state).toBe("restored");
  expect(placements.getPlacement(1)).toMatchObject({ fast_quota_bytes: 1000, cold_quota_bytes: 2000 });
  expect(alertAdmins).not.toHaveBeenCalled();
});

it("records a violation, alerts once, and retries until usage permits the original quota", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 7, "admin", 0);
  quotas.scheduleTemporaryQuotas(7 * DAY);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "ok", result: JSON.stringify({
    fast: { used_bytes: 1500, quota_bytes: 1500 },
  }) });
  quotas.scheduleTemporaryQuotas(7 * DAY + 1);
  expect(quotas.temporaryQuota(1)?.state).toBe("violation");
  expect(placements.getPlacement(1)?.fast_quota_bytes).toBe(1500);
  expect(alertAdmins).toHaveBeenCalledTimes(1);
  quotas.scheduleTemporaryQuotas(7 * DAY + 300001);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "ok", result: JSON.stringify({
    fast: { used_bytes: 800, quota_bytes: 1000 },
  }) });
  quotas.scheduleTemporaryQuotas(7 * DAY + 300002);
  expect(quotas.temporaryQuota(1)?.state).toBe("restored");
  expect(alertAdmins).toHaveBeenCalledTimes(1);
});

it("retains expired work across scheduler restarts and offline nodes", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 1, "admin", 0);
  db.prepare("UPDATE nodes SET online = 0 WHERE id = 1").run();
  quotas.scheduleTemporaryQuotas(3 * DAY);
  quotas.scheduleTemporaryQuotas(4 * DAY);
  expect(enqueueTask).toHaveBeenCalledTimes(2);
  expect(quotas.temporaryQuota(1)?.state).toBe("restoring");
});

it("retries a failed restoration and alerts admins", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 1, "admin", 0);
  quotas.scheduleTemporaryQuotas(DAY);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "failed", error: "disk unavailable" });
  quotas.scheduleTemporaryQuotas(DAY + 1);
  expect(quotas.temporaryQuota(1)?.state).toBe("failed");
  expect(alertAdmins).toHaveBeenCalledTimes(1);
  quotas.scheduleTemporaryQuotas(DAY + 300001);
  expect(enqueueTask).toHaveBeenCalledTimes(3);
});

it("does not declare restoration complete while a branch is missing", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 1, "admin", 0);
  quotas.scheduleTemporaryQuotas(DAY);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "ok", result: JSON.stringify({
    fast: { used_bytes: 100, quota_bytes: 1000, incomplete: true },
  }) });
  quotas.scheduleTemporaryQuotas(DAY + 1);
  expect(quotas.temporaryQuota(1)?.state).toBe("violation");
});

it("protects the saved baseline from overlapping temporary and permanent changes", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 1, "admin", 0);
  expect(() => quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 4000 }, 7, "admin")).toThrow(/temporary quota/);
  expect(() => placements.updatePlacementQuota(1, { fastQuotaBytes: 5000 })).toThrow(/temporary quota/);
  expect(quotas.temporaryQuota(1)?.original_fast).toBe(1000);
});

it("alerts and retries malformed restoration results rather than declaring success", () => {
  quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, 1, "admin", 0);
  quotas.scheduleTemporaryQuotas(DAY);
  tasks.set(quotas.temporaryQuota(1)!.task_id!, { state: "ok", result: "{}" });
  quotas.scheduleTemporaryQuotas(DAY + 1);
  expect(quotas.temporaryQuota(1)?.state).toBe("failed");
  expect(alertAdmins).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, NaN, Infinity, 3651])("rejects invalid duration %s without changing limits", (days) => {
  expect(() => quotas.increaseTemporaryQuota(1, { fastQuotaBytes: 3000 }, days, "admin")).toThrow(/Duration/);
  expect(enqueueTask).not.toHaveBeenCalled();
});

it("rejects reductions, unchanged limits and SMB cold changes", () => {
  for (const fastQuotaBytes of [500, 1000, NaN]) {
    expect(() => quotas.increaseTemporaryQuota(1, { fastQuotaBytes }, 7, "admin")).toThrow();
  }
  db.prepare("UPDATE lab_placements SET cold_quota_bytes = NULL WHERE id = 1").run();
  expect(() => quotas.increaseTemporaryQuota(1, { coldQuotaBytes: 3000 }, 7, "admin")).toThrow(/owner-managed/);
  expect(enqueueTask).not.toHaveBeenCalled();
});

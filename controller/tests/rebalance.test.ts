import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-rebalance-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Capture enqueued tasks instead of touching the honker queue.
const enqueueTask = vi.fn(() => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));

let dbmod: typeof import("../src/lib/db");
let maintenance: typeof import("../src/lib/maintenance");
let settings: typeof import("../src/lib/settings");

const GB = 1024 ** 3;

/**
 * The shape the agent actually sends: `Capabilities.to_dict()`, nested by health area. Building the
 * fixture from the real payload is the point — a hand-written `{zfs: true}` blob (which no agent has
 * ever sent) is what let `capabilities.zfs` read undefined in production while these tests passed.
 */
function agentCapabilities(zfsOk: boolean): object {
  return {
    runtime: { docker_ok: true, bwrap_ok: true },
    nvidia: { gpu_count: 4, nvml_ok: true },
    storage: { zfs_ok: zfsOk, fast_ok: true, cold_ok: true, cold_backend: zfsOk ? "local_zfs" : "smb" },
    health: { status: "ok", issues: [] },
  };
}

function addNode(name: string, zfsOk: boolean, lastRebalance: number | null = null) {
  dbmod
    .db()
    .prepare(
      "INSERT INTO nodes (name, online, capabilities, last_rebalance, created_at) VALUES (?, 1, ?, ?, 0)",
    )
    .run(name, JSON.stringify(agentCapabilities(zfsOk)), lastRebalance);
}

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  maintenance = await import("../src/lib/maintenance");
  settings = await import("../src/lib/settings");
});

beforeEach(() => {
  enqueueTask.mockClear();
  dbmod.db().prepare("DELETE FROM nodes").run();
  settings.setSetting("rebalanceEnabled", true);
  settings.setSetting("rebalanceIntervalHours", 24);
  settings.setSetting("rebalanceMinDeltaGb", 1);
});

describe("storage rebalance scheduling", () => {
  it("does nothing when disabled", () => {
    settings.setSetting("rebalanceEnabled", false);
    addNode("off-node", true);
    expect(maintenance.scheduleRebalances()).toEqual([]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("rebalances due ZFS nodes, skipping non-ZFS and recently-rebalanced ones", () => {
    const now = 1_000_000_000_000;
    addNode("zfs-due", true, null); // never rebalanced -> due
    addNode("smb-only", false, null); // no branch quotas to re-split
    addNode("recent", true, now - 3600 * 1000); // 1h ago, interval is 24h

    const scheduled = maintenance.scheduleRebalances(now);
    expect(scheduled).toEqual(["zfs-due"]);
    // No `tier` key -> both tiers. The configured deadband rides along with the task.
    expect(enqueueTask).toHaveBeenCalledWith(
      "zfs-due",
      "storage.rebalance",
      { min_delta_bytes: GB },
      "rebalance-scheduler",
    );
    const row = dbmod
      .db()
      .prepare("SELECT last_rebalance FROM nodes WHERE name = 'zfs-due'")
      .get() as { last_rebalance: number };
    expect(row.last_rebalance).toBe(now);
  });

  it("has no hour-of-day gate, unlike scrubs — quota writes have no off-peak", () => {
    addNode("any-hour", true, null);
    // 03:00 and 15:00 must behave identically.
    expect(maintenance.scheduleRebalances(Date.UTC(2026, 5, 27, 3, 0, 0))).toEqual(["any-hour"]);
    dbmod.db().prepare("UPDATE nodes SET last_rebalance = NULL").run();
    expect(maintenance.scheduleRebalances(Date.UTC(2026, 5, 27, 15, 0, 0))).toEqual(["any-hour"]);
  });

  it("fires again once the interval has elapsed", () => {
    const now = 1_000_000_000_000;
    settings.setSetting("rebalanceIntervalHours", 1);
    addNode("hourly", true, now - 30 * 60 * 1000); // half an hour ago
    expect(maintenance.scheduleRebalances(now)).toEqual([]);
    expect(maintenance.scheduleRebalances(now + 31 * 60 * 1000)).toEqual(["hourly"]);
  });

  it("clamps a sub-hourly interval so it cannot re-enqueue on every tick", () => {
    const now = 1_000_000_000_000;
    settings.setSetting("rebalanceIntervalHours", 0);
    addNode("clamped", true, now - 60 * 1000); // a minute ago
    // With no clamp a 0-hour interval would make this due immediately.
    expect(maintenance.scheduleRebalances(now)).toEqual([]);
  });

  it("passes a zero deadband through, meaning apply every recomputed split", () => {
    settings.setSetting("rebalanceMinDeltaGb", 0);
    addNode("exact", true, null);
    maintenance.scheduleRebalances(1_000_000_000_000);
    expect(enqueueTask).toHaveBeenCalledWith(
      "exact",
      "storage.rebalance",
      { min_delta_bytes: 0 },
      "rebalance-scheduler",
    );
  });

  it("supports a fractional deadband in GB", () => {
    settings.setSetting("rebalanceMinDeltaGb", 0.5);
    addNode("fractional", true, null);
    maintenance.scheduleRebalances(1_000_000_000_000);
    expect(enqueueTask).toHaveBeenCalledWith(
      "fractional",
      "storage.rebalance",
      { min_delta_bytes: GB / 2 },
      "rebalance-scheduler",
    );
  });
});

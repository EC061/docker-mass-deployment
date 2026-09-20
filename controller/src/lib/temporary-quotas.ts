import { db } from "./db";
import { enqueueTask, getTask } from "./queue";
import { getPlacement, updatePlacementQuota } from "./placements";
import { alertAdmins } from "./alerts";
import { fmtBytes } from "./format";

export interface TemporaryQuota {
  placement_id: number;
  original_fast: number | null;
  original_cold: number | null;
  expires_at: number;
  state: "active" | "restoring" | "violation" | "failed" | "restored";
  task_id: string | null;
  retry_at: number;
  detail: string | null;
  notified: number;
}

export function temporaryQuota(placementId: number): TemporaryQuota | undefined {
  return db().prepare("SELECT * FROM temporary_quotas WHERE placement_id = ?")
    .get(placementId) as TemporaryQuota | undefined;
}

function notifyRestorationFailure(
  row: TemporaryQuota, node: string, lab: string, detail: string, now: number,
): void {
  if (row.notified) return;
  db().prepare(`INSERT INTO logs (ts, node, level, source, lab, msg, detail)
    VALUES (?, ?, 'ERROR', 'temporary-quota', ?, 'Temporary quota restoration violation', ?)`)
    .run(now, node, lab, detail);
  void alertAdmins(`temporary-quota:${row.placement_id}:${row.expires_at}`,
    `Temporary quota expired: ${lab}@${node}`, detail)
    .catch(() => { /* mailer records delivery failures */ });
  db().prepare("UPDATE temporary_quotas SET notified = 1 WHERE placement_id = ?").run(row.placement_id);
}

export function increaseTemporaryQuota(
  placementId: number,
  input: { fastQuotaBytes?: number; coldQuotaBytes?: number | null },
  days: number,
  actor: string,
  now = Date.now(),
): void {
  const p = getPlacement(placementId);
  if (!p || p.state !== "active") throw new Error("Placement must be active");
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("Duration must be a whole number of days between 1 and 3650");
  }
  const fast = input.fastQuotaBytes !== undefined && input.fastQuotaBytes !== p.fast_quota_bytes;
  const cold = input.coldQuotaBytes != null && input.coldQuotaBytes !== p.cold_quota_bytes;
  if (!fast && !cold) throw new Error("Increase at least one quota");
  if ((fast && (!Number.isSafeInteger(input.fastQuotaBytes) || input.fastQuotaBytes! <= p.fast_quota_bytes)) ||
      (cold && (p.cold_quota_bytes === null || !Number.isSafeInteger(input.coldQuotaBytes) ||
        input.coldQuotaBytes! <= p.cold_quota_bytes))) {
    throw new Error("Temporary quotas must increase the current limit; cold storage is owner-managed");
  }
  // Save the baseline in the same DB transaction as the new desired limits.
  db().transaction(() => {
    updatePlacementQuota(placementId, {
      ...(fast ? { fastQuotaBytes: input.fastQuotaBytes } : {}),
      ...(cold ? { coldQuotaBytes: input.coldQuotaBytes } : {}),
    }, actor);
    db().prepare(`INSERT OR REPLACE INTO temporary_quotas
      (placement_id, original_fast, original_cold, expires_at) VALUES (?, ?, ?, ?)`)
      .run(placementId, fast ? p.fast_quota_bytes : null, cold ? p.cold_quota_bytes : null,
        now + days * 86400000);
  })();
}

/** Durable minute-resolution expiry, independent of the optional rebalance schedule. */
export function scheduleTemporaryQuotas(now = Date.now()): void {
  const rows = db().prepare("SELECT * FROM temporary_quotas WHERE state <> 'restored'")
    .all() as TemporaryQuota[];
  for (const row of rows) {
    const p = getPlacement(row.placement_id);
    if (!p || p.state === "deleting") continue;
    try {
      if (row.state === "restoring") {
        const task = row.task_id ? getTask(row.task_id) : null;
        if (task && !["ok", "failed"].includes(task.state)) continue;
        let state: TemporaryQuota["state"] = "failed";
        let detail = task?.error ?? "Quota restoration result unavailable";
        if (task?.state === "ok" && task.result) {
          const result = JSON.parse(task.result);
          const violations: string[] = [];
          for (const [key, baseline, column] of [
            ["fast", row.original_fast, "fast_quota_bytes"],
            ["slow", row.original_cold, "cold_quota_bytes"],
          ] as const) {
            if (baseline === null) continue;
            const used = result[key]?.used_bytes;
            const quota = result[key]?.quota_bytes;
            if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(quota) || quota <= 0) {
              throw new Error("Agent did not report a finite restored quota and usage");
            }
            db().prepare(`UPDATE lab_placements SET ${column} = ? WHERE id = ?`)
              .run(quota, p.id);
            if (used > baseline || quota > baseline || result[key]?.incomplete) {
              violations.push(`${key === "fast" ? "Fast" : "Cold"}: original ${fmtBytes(baseline)}, ` +
                `used ${fmtBytes(used)}, applied limit ${fmtBytes(quota)}` +
                (result[key]?.incomplete ? "; storage branches unavailable" : ""));
            }
          }
          state = violations.length ? "violation" : "restored";
          detail = violations.length ? violations.join("; ") : "Original quotas restored";
        }
        db().prepare(`UPDATE temporary_quotas SET state = ?, detail = ?, retry_at = ?
          WHERE placement_id = ?`).run(state, detail, now + 300000, p.id);
        if (state !== "restored") {
          notifyRestorationFailure(row, p.node_name, p.lab_name, detail, now);
        }
        continue;
      }
      if (row.expires_at > now || row.retry_at > now) continue;
      const task = enqueueTask(p.node_name, "lab.set_quota", {
        lab: p.lab_name, restore_floor: true,
        ...(row.original_fast !== null ? { fast_quota_bytes: row.original_fast } : {}),
        ...(row.original_cold !== null ? { slow_quota_bytes: row.original_cold } : {}),
      }, "temporary-quota-expiry");
      db().prepare("UPDATE temporary_quotas SET state = 'restoring', task_id = ? WHERE placement_id = ?")
        .run(task.id, p.id);
    } catch (error) {
      db().prepare(`UPDATE temporary_quotas SET state = 'failed', detail = ?, retry_at = ?
        WHERE placement_id = ?`).run(String(error), now + 300000, p.id);
      notifyRestorationFailure(row, p.node_name, p.lab_name, String(error), now);
    }
  }
}

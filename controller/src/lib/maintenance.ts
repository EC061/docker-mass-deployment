/**
 * Periodic maintenance: prune logs (and old GPU events) past the configured retention so the DB
 * doesn't grow without bound. Storage samples are kept for the growth charts.
 */

import { db } from "./db";
import { getSetting } from "./settings";

export function pruneOldData(): { logs: number; gpuEvents: number } {
  const retentionMs = getSetting("logRetentionDays") * 86400 * 1000;
  const cutoff = Date.now() - retentionMs;
  const logs = db().prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;
  const gpuEvents = db().prepare("DELETE FROM gpu_events WHERE ts < ?").run(cutoff).changes;
  return { logs, gpuEvents };
}

/** Start a daily prune timer. Returns the timer so callers can clear it if needed. */
export function startMaintenance(): NodeJS.Timeout {
  pruneOldData();
  return setInterval(pruneOldData, 24 * 60 * 60 * 1000);
}

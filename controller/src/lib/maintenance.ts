/**
 * Periodic maintenance: prune logs (and old GPU events) past the configured retention so the DB
 * doesn't grow without bound. Storage samples are kept for the growth charts.
 */

import { backupAll } from "./backup";
import { db } from "./db";
import { getSetting } from "./settings";

export function pruneOldData(): { logs: number; gpuEvents: number } {
  const retentionMs = getSetting("logRetentionDays") * 86400 * 1000;
  const cutoff = Date.now() - retentionMs;
  const logs = db().prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;
  const gpuEvents = db().prepare("DELETE FROM gpu_events WHERE ts < ?").run(cutoff).changes;
  return { logs, gpuEvents };
}

/** Start daily prune + an hourly backup ticker that fires when the configured interval elapses. */
export function startMaintenance(): NodeJS.Timeout {
  pruneOldData();
  let lastBackup = 0;
  const tick = () => {
    pruneOldData();
    const intervalHours = getSetting("backupIntervalHours");
    if (intervalHours > 0 && Date.now() - lastBackup >= intervalHours * 3600 * 1000) {
      lastBackup = Date.now();
      void backupAll();
    }
  };
  return setInterval(tick, 60 * 60 * 1000);
}

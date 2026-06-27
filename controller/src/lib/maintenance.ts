/**
 * Periodic maintenance: prune logs (and old GPU events) past the configured retention so the DB
 * doesn't grow without bound. Storage samples are kept for the growth charts.
 */

import { backupAll } from "./backup";
import { db } from "./db";
import { enqueueTask } from "./queue";
import { getSetting } from "./settings";

export function pruneOldData(): { logs: number; gpuEvents: number } {
  const retentionMs = getSetting("logRetentionDays") * 86400 * 1000;
  const cutoff = Date.now() - retentionMs;
  const logs = db().prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;
  const gpuEvents = db().prepare("DELETE FROM gpu_events WHERE ts < ?").run(cutoff).changes;
  return { logs, gpuEvents };
}

/**
 * Enqueue a ZFS scrub to every online ZFS-capable node whose last scheduled scrub is older than
 * the configured interval. Agents report scrub status/errors back via heartbeat telemetry, so we
 * only need to kick scrubs off here. Returns the nodes a scrub was scheduled for.
 */
export function scheduleScrubs(now = Date.now()): string[] {
  if (!getSetting("scrubEnabled")) return [];
  const intervalMs = getSetting("scrubIntervalDays") * 86400 * 1000;
  const nodes = db()
    .prepare("SELECT name, last_scrub, capabilities FROM nodes WHERE online = 1")
    .all() as { name: string; last_scrub: number | null; capabilities: string | null }[];
  const scheduled: string[] = [];
  for (const n of nodes) {
    let caps: { zfs?: boolean } = {};
    try {
      caps = n.capabilities ? JSON.parse(n.capabilities) : {};
    } catch {
      caps = {};
    }
    if (!caps.zfs) continue; // no ZFS -> nothing to scrub (e.g. all cold storage is SMB)
    if (n.last_scrub && now - n.last_scrub < intervalMs) continue;
    enqueueTask(n.name, "node.scrub", {}, "scrub-scheduler");
    db().prepare("UPDATE nodes SET last_scrub = ? WHERE name = ?").run(now, n.name);
    scheduled.push(n.name);
  }
  return scheduled;
}

/**
 * Enqueue an old-file scan to each online lab whose last scheduled scan is older than the configured
 * interval. The agent walks the lab's datasets and reports counts back (stored in oldfile_scans), so
 * we only need to kick the scans off here. Returns the lab names a scan was scheduled for.
 */
export function scheduleOldFileScans(now = Date.now()): string[] {
  if (!getSetting("oldFileScanEnabled")) return [];
  const intervalMs = getSetting("oldFileScanIntervalDays") * 86400 * 1000;
  const thresholdDays = getSetting("oldFileThresholdDays");
  const labs = db()
    .prepare(
      `SELECT labs.id AS id, labs.name AS name, nodes.name AS node, labs.last_oldfile_scan AS last
       FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE nodes.online = 1`,
    )
    .all() as { id: number; name: string; node: string; last: number | null }[];
  const scheduled: string[] = [];
  for (const lab of labs) {
    if (lab.last && now - lab.last < intervalMs) continue;
    const users = (db()
      .prepare(
        `SELECT students.username AS username FROM lab_members
         JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
      )
      .all(lab.id) as { username: string }[]).map((r) => r.username);
    enqueueTask(
      lab.node,
      "oldfiles.scan",
      { lab: lab.name, users, threshold_days: thresholdDays },
      "oldfile-scheduler",
    );
    db().prepare("UPDATE labs SET last_oldfile_scan = ? WHERE id = ?").run(now, lab.id);
    scheduled.push(lab.name);
  }
  return scheduled;
}

/** Start an hourly ticker: prune old data, run scheduled backups, and kick off due ZFS scrubs. */
export function startMaintenance(): NodeJS.Timeout {
  pruneOldData();
  let lastBackup = 0;
  const tick = () => {
    pruneOldData();
    scheduleScrubs();
    scheduleOldFileScans();
    const intervalHours = getSetting("backupIntervalHours");
    if (intervalHours > 0 && Date.now() - lastBackup >= intervalHours * 3600 * 1000) {
      lastBackup = Date.now();
      void backupAll();
    }
  };
  return setInterval(tick, 60 * 60 * 1000);
}

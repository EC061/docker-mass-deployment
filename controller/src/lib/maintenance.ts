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

/** Current hour-of-day (0-23) in an IANA timezone, or null if the tz name is invalid. */
export function hourInTimezone(now: number, tz: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
    const h = Number(fmt.format(new Date(now)));
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** Offset in ms such that local-wall-clock = utc + offset, for an instant in a timezone. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - utcMs;
}

/** The UTC instant for a wall-clock time on a given calendar day in a timezone. */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  let ts = Date.UTC(y, mo, d, h, mi, 0);
  // Two passes converge across DST boundaries (the offset depends on the instant we're solving for).
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo, d, h, mi, 0) - tzOffsetMs(ts, tz);
  return ts;
}

/** The anchor-aligned schedule grid, or null when scheduled backups are off / misconfigured. */
function backupGrid(now: number): { anchor: number; intervalMs: number } | null {
  if (!getSetting("backupEnabled")) return null;
  const intervalHours = getSetting("backupIntervalHours");
  if (!(intervalHours > 0)) return null;
  const tz = getSetting("backupTimezone");
  let parts: Record<string, number>;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    parts = {};
    for (const part of fmt.formatToParts(new Date(now))) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
  } catch {
    return null; // invalid timezone -> don't fire on a guess
  }
  const anchor = wallClockToUtc(
    parts.year,
    parts.month - 1,
    parts.day,
    getSetting("backupAnchorHour"),
    getSetting("backupAnchorMinute"),
    tz,
  );
  return { anchor, intervalMs: intervalHours * 3600 * 1000 };
}

/** First scheduled instant strictly after `ref` on the anchor grid, or null if disabled. */
function slotAfter(ref: number, now: number): number | null {
  const g = backupGrid(now);
  if (!g) return null;
  const k = Math.floor((ref - g.anchor) / g.intervalMs) + 1;
  let next = g.anchor + k * g.intervalMs;
  while (next <= ref) next += g.intervalMs;
  return next;
}

/** The next scheduled backup instant (epoch ms), or null if scheduled backups are off. */
export function nextBackupRun(now = Date.now()): number | null {
  // Reference off the last run, but never further back than one interval, so a never-run or
  // long-idle controller still shows a sensible near-future time rather than an ancient slot.
  const intervalMs = getSetting("backupIntervalHours") * 3600 * 1000;
  const ref = Math.max(getSetting("backupLastRun"), now - intervalMs);
  return slotAfter(ref, now);
}

/** Whether a scheduled backup is due (the slot after the last run has arrived). */
export function backupDue(now = Date.now()): boolean {
  const next = slotAfter(getSetting("backupLastRun"), now);
  return next !== null && now >= next;
}

/**
 * Enqueue a ZFS scrub to every online ZFS-capable node whose last scheduled scrub is older than the
 * configured interval, but only during the configured hour-of-day (in the configured timezone) so
 * scrubs run off-peak. Agents report scrub status/errors back via heartbeat telemetry, so we only
 * need to kick scrubs off here. Returns the nodes a scrub was scheduled for. Since the maintenance
 * ticker runs hourly, the configured hour is effectively a one-hour window.
 */
export function scheduleScrubs(now = Date.now()): string[] {
  if (!getSetting("scrubEnabled")) return [];
  // Gate on time-of-day: only proceed when the current hour matches the configured scrub hour. An
  // invalid timezone falls back to "no gate" so a misconfiguration never silently disables scrubs.
  const hour = hourInTimezone(now, getSetting("scrubTimezone"));
  if (hour !== null && hour !== getSetting("scrubHour")) return [];
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
  const tick = () => {
    pruneOldData();
    scheduleScrubs();
    scheduleOldFileScans();
    // backupAll persists the last-run timestamp, so the schedule survives restarts and the next slot
    // is computed off durable state rather than an in-memory counter.
    if (backupDue()) void backupAll();
  };
  return setInterval(tick, 60 * 60 * 1000);
}

/**
 * Periodic maintenance: prune logs (and old GPU events) past the configured retention so the DB
 * doesn't grow without bound. Storage samples are kept for the growth charts.
 */

import { backupAll } from "./backup";
import { db } from "./db";
import { enqueueTask } from "./queue";
import { getSetting } from "./settings";

// Approximate byte size of a single `logs` row's textual content. SQLite has no cheap per-table
// size, so we sum the text-column lengths plus a fixed estimate for the int columns + row overhead.
// Used for the size-based rotation cap and the "~X stored" readout in settings.
const LOG_ROW_BYTES = `(
  LENGTH(msg)
  + LENGTH(COALESCE(detail, ''))
  + LENGTH(COALESCE(source, ''))
  + LENGTH(COALESCE(node, ''))
  + LENGTH(COALESCE(lab, ''))
  + LENGTH(COALESCE(user, ''))
  + LENGTH(COALESCE(task_id, ''))
  + 48
)`;

/** Approximate total textual size (bytes) of the `logs` table — for the size cap and the UI. */
export function logsContentBytes(): number {
  const row = db().prepare(`SELECT COALESCE(SUM(${LOG_ROW_BYTES}), 0) AS bytes FROM logs`).get() as {
    bytes: number;
  };
  return row.bytes;
}

/**
 * Enforce the three log-rotation caps on the `logs` table, newest-wins, and return the number of
 * rows removed:
 *   - age:   drop rows older than logRetentionDays
 *   - count: keep only the newest logMaxEntries rows
 *   - size:  keep only the newest rows whose cumulative content size fits logMaxSizeMb
 * A cap of 0 disables that dimension. Row recency is taken from the autoincrement id (true arrival
 * order, immune to per-node clock skew) for the count/size caps; the age cap uses the agent ts.
 */
export function pruneLogs(now = Date.now()): number {
  let removed = 0;

  const retentionDays = getSetting("logRetentionDays");
  if (retentionDays > 0) {
    const cutoff = now - retentionDays * 86400 * 1000;
    removed += db().prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;
  }

  const maxEntries = getSetting("logMaxEntries");
  if (maxEntries > 0) {
    // OFFSET lands on the id of the (maxEntries+1)-th newest row; drop it and everything older.
    // When there are fewer rows than the cap the subquery is NULL, so `id <= NULL` deletes nothing.
    removed += db()
      .prepare("DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(maxEntries).changes;
  }

  const maxBytes = getSetting("logMaxSizeMb") * 1024 * 1024;
  if (maxBytes > 0) {
    // Walk newest -> oldest accumulating row size; once the running total passes the cap, every
    // remaining (older) row is surplus.
    removed += db()
      .prepare(
        `DELETE FROM logs WHERE id IN (
           SELECT id FROM (
             SELECT id, SUM(${LOG_ROW_BYTES}) OVER (ORDER BY id DESC) AS cum FROM logs
           ) WHERE cum > ?
         )`,
      )
      .run(maxBytes).changes;
  }

  return removed;
}

export function pruneOldData(): { logs: number; gpuEvents: number } {
  const now = Date.now();
  const logs = pruneLogs(now);
  const retentionDays = getSetting("logRetentionDays");
  const gpuEvents =
    retentionDays > 0
      ? db().prepare("DELETE FROM gpu_events WHERE ts < ?").run(now - retentionDays * 86400 * 1000)
          .changes
      : 0;
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

// Re-fire guard for the nightly usage scan: long enough not to fire twice in one night's hour
// window, short enough that day-to-day drift in when the hourly ticker lands never skips a night.
const USAGE_SCAN_MIN_GAP_MS = 20 * 3600 * 1000;

/**
 * Enqueue a per-student usage (du) scan to each online lab once a night, during the configured hour
 * (in usageScanTimezone, default midnight). The agent measures each student's home/scratch/cold
 * usage and reports it back on its heartbeat; we only kick the scans off here. Returns the lab names
 * a scan was scheduled for. Lab-level usage (image + fast/cold) is NOT scheduled here — the agent
 * recomputes it on its own ~5-min cadence. Since the maintenance ticker runs hourly, the configured
 * hour is a one-hour window; last_usage_scan guards against enqueuing the same lab twice in a night.
 */
export function scheduleUsageScans(now = Date.now()): string[] {
  if (!getSetting("usageScanEnabled")) return [];
  // Gate on time-of-day: only proceed when the current hour matches. An invalid timezone falls back
  // to "no gate" so a misconfiguration never silently disables the scan (the gap guard still bounds it).
  const hour = hourInTimezone(now, getSetting("usageScanTimezone"));
  if (hour !== null && hour !== getSetting("usageScanHour")) return [];
  // One scan per ACTIVE placement on an online node (a lab may run on several nodes).
  const placements = db()
    .prepare(
      `SELECT p.id AS id, p.lab_id AS lab_id, labs.name AS lab, nodes.name AS node, p.last_usage_scan AS last
       FROM lab_placements p
       JOIN labs ON labs.id = p.lab_id
       JOIN nodes ON nodes.id = p.node_id
       WHERE nodes.online = 1 AND p.state = 'active'`,
    )
    .all() as { id: number; lab_id: number; lab: string; node: string; last: number | null }[];
  const scheduled: string[] = [];
  for (const p of placements) {
    if (p.last && now - p.last < USAGE_SCAN_MIN_GAP_MS) continue;
    const users = (db()
      .prepare(
        `SELECT students.username AS username FROM lab_members
         JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
      )
      .all(p.lab_id) as { username: string }[]).map((r) => r.username);
    enqueueTask(p.node, "usage.scan", { lab: p.lab, users }, "usage-scheduler");
    db().prepare("UPDATE lab_placements SET last_usage_scan = ? WHERE id = ?").run(now, p.id);
    scheduled.push(`${p.lab}@${p.node}`);
  }
  return scheduled;
}

/** Start an hourly ticker: prune old data, run scheduled backups, and kick off due scrubs + scans. */
export function startMaintenance(): NodeJS.Timeout {
  pruneOldData();
  const tick = () => {
    pruneOldData();
    scheduleScrubs();
    scheduleUsageScans();
    // backupAll persists the last-run timestamp, so the schedule survives restarts and the next slot
    // is computed off durable state rather than an in-memory counter.
    if (backupDue()) void backupAll();
  };
  return setInterval(tick, 60 * 60 * 1000);
}

/**
 * Controller DB backup/restore to WebDAV.
 *
 * Backup: take a consistent snapshot of controller.db via `VACUUM INTO` (safe while the DB is live),
 * upload it to WebDAV as both a timestamped file and `controller-latest.db`, then prune old
 * timestamped backups down to the grandfather-father-son retention policy.
 *
 * Restore: download a backup and stage it as `<dbPath>.restore`. On next boot, db() swaps a staged
 * restore in before opening (see applyStagedRestore). This avoids mutating an open SQLite file.
 *
 * Backups live in an env-scoped collection (see webdavConfig) so a prod and a dev controller can
 * share one WebDAV target without clobbering each other.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { db } from "./db";
import { env } from "./env";
import {
  getSetting,
  isWebdavConfigured,
  setSetting,
  webdavConfig,
} from "./settings";
import * as webdav from "./webdav";

const LATEST = "controller-latest.db";
const PREFIX = "controller-";

function snapshot(): Buffer {
  const tmp = `${env.dbPath}.snapshot`;
  if (existsSync(tmp)) unlinkSync(tmp);
  // VACUUM INTO writes a clean, consistent copy of the live DB.
  db().prepare("VACUUM INTO ?").run(tmp);
  const data = readFileSync(tmp);
  unlinkSync(tmp);
  return data;
}

/** Parse the epoch-ms timestamp out of a `controller-<stamp>.db` name; null if it doesn't match. */
function parseStamp(name: string): number | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(".db") || name === LATEST) return null;
  const n = Number(name.slice(PREFIX.length, -3));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface BackupResult {
  ok: boolean;
  name?: string;
  bytes?: number;
  error?: string;
}

export interface BackupEntry {
  name: string;
  stamp: number; // epoch ms
}

/** Persist the outcome of a backup run so the UI can show last-run status / errors. */
function recordRun(stamp: number, r: BackupResult): void {
  setSetting("backupLastRun", stamp);
  setSetting("backupLastStatus", r.ok ? "ok" : "failed");
  setSetting("backupLastError", r.ok ? "" : r.error ?? "Unknown error");
  if (r.ok && r.name) setSetting("backupLastName", r.name);
}

/** Back up the controller DB and ask every node to back up its local state DB to the same WebDAV. */
export async function backupAll(stamp = Date.now()): Promise<BackupResult> {
  const result = await backupNow(stamp);
  recordRun(stamp, result);
  if (isWebdavConfigured()) {
    const cfg = webdavConfig();
    const nodes = db().prepare("SELECT name FROM nodes").all() as { name: string }[];
    const { enqueueTask } = await import("./queue");
    for (const n of nodes) {
      enqueueTask(n.name, "node.backup", {
        webdav: { url: `${cfg.url}/nodes/${n.name}`, user: cfg.user, pass: cfg.pass },
      });
    }
  }
  return result;
}

export async function backupNow(stamp = Date.now()): Promise<BackupResult> {
  if (!isWebdavConfigured()) return { ok: false, error: "WebDAV not configured" };
  try {
    const cfg = webdavConfig();
    await webdav.ensureCollection(cfg);
    const data = snapshot();
    const name = `${PREFIX}${stamp}.db`;
    await webdav.put(cfg, name, data);
    await webdav.put(cfg, LATEST, data);
    await pruneBackups();
    return { ok: true, name, bytes: data.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Grandfather-father-son selection: keep the newest `recent`, plus the newest backup in each of the
 * most recent `weekly` weeks, `monthly` months, and `yearly` years. Returns the stamps to retain.
 */
function selectKeep(
  stamps: number[],
  keep: { recent: number; weekly: number; monthly: number; yearly: number },
): Set<number> {
  const sorted = [...stamps].sort((a, b) => b - a); // newest first
  const keepSet = new Set<number>();
  for (let i = 0; i < Math.min(keep.recent, sorted.length); i++) keepSet.add(sorted[i]);

  // For the most recent `count` distinct buckets, keep the newest backup falling in each.
  const keepPerBucket = (bucketOf: (s: number) => string, count: number) => {
    if (count <= 0) return;
    const seen = new Set<string>();
    for (const s of sorted) {
      const b = bucketOf(s);
      if (seen.has(b)) continue; // an even newer backup already represents this bucket
      if (seen.size >= count) break; // past the N most-recent buckets
      seen.add(b);
      keepSet.add(s);
    }
  };
  const week = (s: number) => String(Math.floor(s / 604_800_000)); // 7 days, epoch-anchored
  const month = (s: number) => {
    const d = new Date(s);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  };
  const year = (s: number) => String(new Date(s).getUTCFullYear());
  keepPerBucket(week, keep.weekly);
  keepPerBucket(month, keep.monthly);
  keepPerBucket(year, keep.yearly);
  return keepSet;
}

async function pruneBackups(): Promise<void> {
  const cfg = webdavConfig();
  const entries = (await webdav.list(cfg))
    .map((name) => ({ name, stamp: parseStamp(name) }))
    .filter((e): e is BackupEntry => e.stamp !== null);
  const keep = selectKeep(entries.map((e) => e.stamp), {
    recent: getSetting("backupKeepRecent"),
    weekly: getSetting("backupKeepWeekly"),
    monthly: getSetting("backupKeepMonthly"),
    yearly: getSetting("backupKeepYearly"),
  });
  for (const e of entries) {
    if (!keep.has(e.stamp)) await webdav.del(cfg, e.name);
  }
}

/** Timestamped backups, newest first, for the current environment. */
export async function listBackups(): Promise<BackupEntry[]> {
  if (!isWebdavConfigured()) return [];
  return (await webdav.list(webdavConfig()))
    .map((name) => ({ name, stamp: parseStamp(name) }))
    .filter((e): e is BackupEntry => e.stamp !== null)
    .sort((a, b) => b.stamp - a.stamp);
}

/** Verify the WebDAV target is reachable and writable with the configured credentials. */
export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!isWebdavConfigured()) return { ok: false, error: "WebDAV not configured" };
  try {
    const cfg = webdavConfig();
    await webdav.ensureCollection(cfg);
    // A round-trip PUT/DELETE surfaces auth (401), gateway (502), and read-only errors that a
    // bare PROPFIND would swallow.
    await webdav.put(cfg, ".labmgr-probe", Buffer.from("ok"));
    await webdav.del(cfg, ".labmgr-probe");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Download a backup and stage it; takes effect on the next controller restart. */
export async function stageRestore(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!isWebdavConfigured()) return { ok: false, error: "WebDAV not configured" };
  // Whitelist against the actual backup list — never fetch an attacker-chosen name onto disk as the
  // next-boot DB. basename() already blocks traversal; this also blocks substituting a foreign file.
  const safe = basename(name);
  const known = await listBackups();
  if (!known.some((e) => e.name === safe)) return { ok: false, error: "Unknown backup name" };
  try {
    const data = await webdav.get(webdavConfig(), safe);
    writeFileSync(`${env.dbPath}.restore`, data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

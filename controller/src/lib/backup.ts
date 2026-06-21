/**
 * Controller DB backup/restore to WebDAV.
 *
 * Backup: take a consistent snapshot of controller.db via `VACUUM INTO` (safe while the DB is live),
 * upload it to WebDAV as both a timestamped file and `controller-latest.db`, then prune old
 * timestamped backups beyond the retention count.
 *
 * Restore: download a backup and stage it as `<dbPath>.restore`. On next boot, db() swaps a staged
 * restore in before opening (see applyStagedRestore). This avoids mutating an open SQLite file.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { db } from "./db";
import { env } from "./env";
import { getSetting, isWebdavConfigured, webdavConfig } from "./settings";
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

export interface BackupResult {
  ok: boolean;
  name?: string;
  bytes?: number;
  error?: string;
}

/** Back up the controller DB and ask every node to back up its local state DB to the same WebDAV. */
export async function backupAll(stamp = Date.now()): Promise<BackupResult> {
  const result = await backupNow(stamp);
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

async function pruneBackups(): Promise<void> {
  const retention = getSetting("webdavRetention");
  const cfg = webdavConfig();
  const stamped = (await webdav.list(cfg))
    .filter((n) => n.startsWith(PREFIX) && n !== LATEST)
    .sort(); // timestamp-named -> lexical sort == chronological
  const excess = stamped.length - retention;
  for (let i = 0; i < excess; i++) {
    await webdav.del(cfg, stamped[i]);
  }
}

export async function listBackups(): Promise<string[]> {
  if (!isWebdavConfigured()) return [];
  return (await webdav.list(webdavConfig()))
    .filter((n) => n.startsWith(PREFIX))
    .sort()
    .reverse();
}

/** Download a backup and stage it; takes effect on the next controller restart. */
export async function stageRestore(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!isWebdavConfigured()) return { ok: false, error: "WebDAV not configured" };
  // Whitelist against the actual backup list — never fetch an attacker-chosen name onto disk as the
  // next-boot DB. basename() already blocks traversal; this also blocks substituting a foreign file.
  const safe = basename(name);
  const known = await listBackups();
  if (!known.includes(safe)) return { ok: false, error: "Unknown backup name" };
  try {
    const data = await webdav.get(webdavConfig(), safe);
    writeFileSync(`${env.dbPath}.restore`, data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

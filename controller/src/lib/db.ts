/**
 * Authoritative SQLite database (WAL). Opened once per process as a singleton.
 *
 * We use better-sqlite3 (synchronous, fast) with a tiny embedded migration runner rather than an
 * ORM, so the schema is explicit and the same DB file can host honker's queue tables alongside ours.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";

/** If a WebDAV restore was staged as <dbPath>.restore, swap it in before opening. */
function applyStagedRestore(dbPath: string): void {
  const staged = `${dbPath}.restore`;
  if (!existsSync(staged)) return;
  for (const suffix of ["-wal", "-shm"]) {
    const f = `${dbPath}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }
  renameSync(staged, dbPath);
}

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(env.dbPath), { recursive: true });
  // If a WebDAV restore was staged, swap it in before opening the DB.
  applyStagedRestore(env.dbPath);
  const conn = new Database(env.dbPath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  migrate(conn);
  _db = conn;
  return conn;
}

/** Ordered migrations. Append-only — never edit a shipped migration. */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
    CREATE TABLE admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      last_seen INTEGER,
      online INTEGER NOT NULL DEFAULT 0,
      capabilities TEXT,          -- JSON blob from the hello frame
      pools TEXT,                 -- JSON: latest pool free space from telemetry
      created_at INTEGER NOT NULL
    );

    CREATE TABLE labs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      node_id INTEGER NOT NULL REFERENCES nodes(id),
      pi_email TEXT,
      fast_quota_bytes INTEGER NOT NULL,
      slow_quota_bytes INTEGER NOT NULL,
      image TEXT NOT NULL,
      ssh_port INTEGER,
      -- creation-time container options (frozen after create; JSON)
      container_options TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT UNIQUE,
      username TEXT NOT NULL,
      email TEXT,
      name TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE lab_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      scratch_quota_bytes INTEGER,
      cold_quota_bytes INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(lab_id, student_id)
    );

    CREATE TABLE task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_uuid TEXT NOT NULL UNIQUE,  -- the TaskFrame.id
      job_id INTEGER,             -- honker job id
      node TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT,
      requested_by TEXT,
      state TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|ok|failed
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      node TEXT,
      level TEXT NOT NULL,
      source TEXT,
      lab TEXT,
      user TEXT,
      task_id TEXT,
      msg TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX idx_logs_ts ON logs(ts);
    CREATE INDEX idx_logs_level ON logs(level);

    CREATE TABLE gpu_snapshot (
      node TEXT NOT NULL,
      pid INTEGER NOT NULL,
      user TEXT,
      lab TEXT,
      vram_bytes INTEGER,
      util REAL,
      ts INTEGER NOT NULL,
      PRIMARY KEY(node, pid)
    );

    CREATE TABLE gpu_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node TEXT NOT NULL,
      pid INTEGER,
      user TEXT,
      lab TEXT,
      vram_bytes INTEGER,
      state TEXT NOT NULL,        -- idle|warned|killed
      ts INTEGER NOT NULL
    );

    CREATE TABLE storage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      pool TEXT NOT NULL,         -- fast|slow
      used_bytes INTEGER NOT NULL,
      quota_bytes INTEGER,
      ts INTEGER NOT NULL
    );
    CREATE INDEX idx_storage_ts ON storage_samples(ts);

    CREATE TABLE oldfile_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      atime_count INTEGER, atime_bytes INTEGER,
      mtime_count INTEGER, mtime_bytes INTEGER,
      oldest INTEGER,
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE quota_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      pool TEXT NOT NULL,
      pct REAL NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
    `,
  },
  {
    id: "0002_scrub",
    sql: `
    ALTER TABLE nodes ADD COLUMN last_scrub INTEGER;      -- last time a scrub was scheduled
    ALTER TABLE nodes ADD COLUMN scrub_status TEXT;       -- JSON: latest per-pool scrub status
    `,
  },
  {
    id: "0003_admin_session_state",
    sql: `
    -- is_active soft-disables an admin without deleting the row; token_version is embedded in the
    -- session JWT so bumping it (logout-all / disable) invalidates all of that admin's outstanding
    -- cookies. requireAdmin() re-checks both against the DB on every privileged action.
    ALTER TABLE admins ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE admins ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "0004_node_tokens",
    sql: `
    -- Per-node identity. token_hash is the bcrypt hash of a node's own token (NULL = not yet
    -- provisioned); allowed is the name allow-list flag; token_pinned_at records first successful
    -- per-node auth (first-seen pin); auth_mode is 'legacy' (shared AGENT_TOKEN) or 'pernode'.
    ALTER TABLE nodes ADD COLUMN token_hash TEXT;
    ALTER TABLE nodes ADD COLUMN allowed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE nodes ADD COLUMN token_pinned_at INTEGER;
    ALTER TABLE nodes ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'legacy';
    -- Pre-existing nodes were trusted under the shared token; keep them connecting on upgrade.
    UPDATE nodes SET allowed = 1, auth_mode = 'legacy';
    `,
  },
  {
    id: "0005_oldfile_schedule",
    sql: `
    -- Last time a nightly old-file scan was scheduled for this lab (mirrors nodes.last_scrub).
    ALTER TABLE labs ADD COLUMN last_oldfile_scan INTEGER;
    `,
  },
];

function migrate(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    conn.prepare("SELECT id FROM _migrations").all().map((r: any) => r.id as string),
  );
  const insert = conn.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = conn.transaction(() => {
      conn.exec(m.sql);
      insert.run(m.id, Date.now());
    });
    tx();
  }
}

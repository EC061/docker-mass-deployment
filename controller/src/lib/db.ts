/**
 * Authoritative SQLite database (WAL). Opened once per process as a singleton.
 *
 * We use better-sqlite3 (synchronous, fast) with a tiny embedded migration runner rather than an
 * ORM, so the schema is explicit and the same DB file can host honker's queue tables alongside ours.
 */

import Database from "better-sqlite3";
// node:fs / node:path are loaded via process.getBuiltinModule rather than a static import so the
// Turbopack build tracer doesn't see filesystem calls here and pull the whole project into the
// (unused — we run a custom server, not standalone output) NFT trace. See the build warning at
// https://nextjs.org/docs/messages/nft-unexpected-file.
const { existsSync, mkdirSync, renameSync, rmSync } = process.getBuiltinModule("node:fs");
const { dirname } = process.getBuiltinModule("node:path");
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

/**
 * Ordered migrations. Append-only — never edit a shipped migration. Each entry runs either a `sql`
 * string or a `fn(conn)` (for guards / data-dependent logic), inside a single transaction.
 */
const MIGRATIONS: { id: string; sql?: string; fn?: (conn: Database.Database) => void }[] = [
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
      pool TEXT NOT NULL,         -- fast|slow|docker
      used_bytes INTEGER NOT NULL,
      quota_bytes INTEGER,
      ts INTEGER NOT NULL
    );
    CREATE INDEX idx_storage_ts ON storage_samples(ts);

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
  {
    id: "0006_node_alias_announcements",
    sql: `
    -- Human-friendly display name for a node, set in the UI. The 'name' stays the DNS-label
    -- identity used for auth/queueing; alias is purely cosmetic (shown in the UI and alerts).
    ALTER TABLE nodes ADD COLUMN alias TEXT;

    -- Service announcements broadcast by email to students and/or PIs. One row per send,
    -- kept for an audit trail and shown as recent history on the Announcements page.
    CREATE TABLE announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT,
      audiences TEXT NOT NULL,    -- comma-separated: students,pis
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      recipients INTEGER NOT NULL, -- distinct addresses targeted
      sent INTEGER NOT NULL,       -- addresses the SMTP send succeeded for
      skipped INTEGER NOT NULL DEFAULT 0  -- 1 if SMTP was not configured (nothing sent)
    );
    CREATE INDEX idx_announcements_ts ON announcements(ts);
    `,
  },
  {
    id: "0007_usage_scan_time",
    sql: `
    -- Last time the agent ran a per-student usage (du) scan for this lab, reported by its heartbeat.
    -- Drives the Stats page freshness ("updated X ago") and the conditional "Scan now" button.
    ALTER TABLE labs ADD COLUMN usage_scanned_at INTEGER;
    `,
  },
  {
    id: "0008_drop_oldfiles",
    sql: `
    -- The old-file scanning feature was removed. Drop its results table and repurpose the per-lab
    -- schedule bookkeeping column for the nightly per-student usage (du) scan that replaced it
    -- (last_usage_scan = last time the controller enqueued a nightly usage.scan for this lab).
    DROP TABLE IF EXISTS oldfile_scans;
    ALTER TABLE labs RENAME COLUMN last_oldfile_scan TO last_usage_scan;
    `,
  },
  {
    // Redesign: split node-pinned labs into node-independent LOGICAL labs + per-node PLACEMENTS +
    // per-placement student state. This is intentionally NOT backward compatible (pre-release): the
    // guard refuses to migrate while any legacy labs/nodes/students rows remain, so the operator must
    // export + delete old labs/placements and delete all nodes (then reprovision) before upgrading.
    // Admin accounts and controller settings are preserved.
    id: "0009_redesign_placements",
    fn: (conn) => {
      const count = (t: string): number =>
        (conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      const legacy = count("labs") + count("nodes") + count("students");
      if (legacy > 0) {
        throw new Error(
          "Cannot upgrade: the redesigned schema requires labs, nodes, and students to be empty " +
            "(legacy node-bound labs and shared-token nodes are not migrated). Export anything you " +
            "need, then delete every lab/placement and every node (reprovision nodes after upgrade). " +
            "Admin accounts and controller settings are preserved. See UPGRADING.md.",
        );
      }
      conn.exec(`
        -- Drop children before parents; all are guaranteed empty by the guard above.
        DROP TABLE IF EXISTS placement_members;
        DROP TABLE IF EXISTS lab_placements;
        DROP TABLE IF EXISTS lab_members;
        DROP TABLE IF EXISTS storage_samples;
        DROP TABLE IF EXISTS quota_alerts;
        DROP TABLE IF EXISTS labs;
        DROP TABLE IF EXISTS students;

        -- Students: globally reusable, matched by student_id (when present) then username.
        CREATE TABLE students (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id TEXT UNIQUE,            -- import identity when present
          username TEXT NOT NULL UNIQUE,     -- normalized; globally unique
          email TEXT,
          name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT 0
        );

        -- Logical lab: node-independent. Operational config lives on placements.
        CREATE TABLE labs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,         -- globally unique, filesystem-safe
          pi_name TEXT,
          pi_email TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT 0
        );

        -- The logical roster. Membership is synced to every placement.
        CREATE TABLE lab_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
          student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          UNIQUE(lab_id, student_id)
        );

        -- One lab on one node. Carries the node-specific quotas/image/port/options + lifecycle state.
        CREATE TABLE lab_placements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
          node_id INTEGER NOT NULL REFERENCES nodes(id),
          fast_quota_bytes INTEGER NOT NULL,
          cold_quota_bytes INTEGER,          -- NULL on SMB-client placements (owner-managed cold)
          ssh_port INTEGER NOT NULL,
          image TEXT NOT NULL,
          container_options TEXT,            -- JSON; frozen after create (change via recreate)
          state TEXT NOT NULL DEFAULT 'queued',   -- queued|provisioning|active|failed|deleting
          last_error TEXT,
          usage_scanned_at INTEGER,          -- last per-student du scan time, from telemetry
          last_usage_scan INTEGER,           -- last time controller enqueued a nightly usage.scan
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(lab_id, node_id),
          UNIQUE(node_id, ssh_port)
        );

        -- Per-(placement, student) provisioning state, so a per-node failure stays visible+retryable.
        CREATE TABLE placement_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          placement_id INTEGER NOT NULL REFERENCES lab_placements(id) ON DELETE CASCADE,
          student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          state TEXT NOT NULL DEFAULT 'queued',  -- queued|provisioning|active|failed|removing
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(placement_id, student_id)
        );

        -- Storage samples now carry the placement (a lab can run on several nodes).
        CREATE TABLE storage_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          placement_id INTEGER REFERENCES lab_placements(id) ON DELETE CASCADE,
          lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
          student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
          pool TEXT NOT NULL,                -- fast|slow|docker
          used_bytes INTEGER NOT NULL,
          quota_bytes INTEGER,
          ts INTEGER NOT NULL
        );
        CREATE INDEX idx_storage_ts ON storage_samples(ts);
        CREATE INDEX idx_storage_placement ON storage_samples(placement_id);

        CREATE TABLE quota_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          placement_id INTEGER REFERENCES lab_placements(id) ON DELETE CASCADE,
          lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
          pool TEXT NOT NULL,
          pct REAL NOT NULL,
          ts INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Phase 3: per-node cold-storage configuration. cold_backend is admin-set (local_zfs node owns
    // real ZFS cold; smb node replaces cold with a mount of an owner's shared dataset). cold_owner_
    // node_id points an SMB client at its local-ZFS owner. cold_mount_path / cold_ready are reported
    // by the agent (the live mount path and whether it is an active mount). nodes is empty after the
    // 0009 guard, so the NOT NULL defaults apply to future rows.
    id: "0010_node_cold_storage",
    sql: `
    ALTER TABLE nodes ADD COLUMN cold_backend TEXT NOT NULL DEFAULT 'local_zfs';
    ALTER TABLE nodes ADD COLUMN cold_owner_node_id INTEGER REFERENCES nodes(id);
    ALTER TABLE nodes ADD COLUMN cold_mount_path TEXT;
    ALTER TABLE nodes ADD COLUMN cold_ready INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Phase 7: node tokens move from bcrypt + shared-token fallback to a single per-node HMAC.
    // token_hash now stores HMAC-SHA256(key=AGENT_TOKEN, msg=name + NUL + plaintext), hex (see
    // lib/nodes.ts). There is no shared/legacy token and no first-seen pin, so the auth_mode and
    // token_pinned_at columns are dropped. nodes is empty here (the 0009 guard requires it and nodes
    // are reprovisioned after upgrade); clear any token_hash anyway so a hash left over from an
    // intermediate redesign commit (a bcrypt string) fails closed and forces a reprovision rather
    // than being misread as an HMAC.
    id: "0011_node_hmac_tokens",
    sql: `
    UPDATE nodes SET token_hash = NULL;
    ALTER TABLE nodes DROP COLUMN auth_mode;
    ALTER TABLE nodes DROP COLUMN token_pinned_at;
    `,
  },
  {
    // Phase 8: durable, idempotent task flow. received_at records the agent's durable receipt of a
    // pushed task (it persisted it locally); attempts counts how many times the hub (re)sent it;
    // result_cached marks a result the agent replayed from its local cache — a redelivered task it
    // had already completed — rather than re-executing.
    id: "0012_task_durability",
    sql: `
    ALTER TABLE task_log ADD COLUMN received_at INTEGER;
    ALTER TABLE task_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE task_log ADD COLUMN result_cached INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Phase 9: attribute GPU rows to a placement. The lab a process belongs to now comes from the
    // container's lab-agent.lab label (authoritative), and (lab, node) -> placement, so the controller
    // can link a GPU process/event to its placement. Nullable: a host/unmanaged process has no lab.
    id: "0013_gpu_placement",
    sql: `
    ALTER TABLE gpu_snapshot ADD COLUMN placement_id INTEGER REFERENCES lab_placements(id) ON DELETE SET NULL;
    ALTER TABLE gpu_events ADD COLUMN placement_id INTEGER REFERENCES lab_placements(id) ON DELETE SET NULL;
    `,
  },
  {
    // Phase 10: emails are now treated case-insensitively (normalized to lower+trim on write and
    // lookup). Normalize any pre-existing rows so an account created with mixed case still matches at
    // login. admins.email is UNIQUE — a genuine case-only duplicate would (correctly) fail here.
    id: "0014_normalize_emails",
    sql: `
    UPDATE admins SET email = lower(trim(email))
      WHERE email IS NOT NULL AND email <> lower(trim(email));
    UPDATE students SET email = lower(trim(email))
      WHERE email IS NOT NULL AND email <> lower(trim(email));
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
      if (m.sql) conn.exec(m.sql);
      if (m.fn) m.fn(conn);
      insert.run(m.id, Date.now());
    });
    tx();
  }
}

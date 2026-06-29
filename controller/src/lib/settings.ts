/**
 * Operational settings, stored in the `settings` key/value table and editable in the UI.
 * Everything tunable at runtime lives here (quota defaults, SSH port range, old-file threshold,
 * and — added in later phases — SMTP, WebDAV, GPU policy, alert threshold).
 */

import { db } from "./db";
import { enqueueTask } from "./queue";
import { env } from "./env";
import { decryptSecret, encryptSecret } from "./secrets";

export const TIB = 1024 ** 4;

// Credential settings encrypted at rest (M-05). Stored AES-GCM-encrypted; decrypted on read.
const ENCRYPTED_KEYS = new Set<keyof Settings>(["smtpPass", "webdavPass"]);

export interface Settings {
  fastQuotaDefaultBytes: number;
  slowQuotaDefaultBytes: number;
  sshPortStart: number;
  sshPortEnd: number;
  oldFileThresholdDays: number;
  // Nightly old-file scan. The controller enqueues oldfiles.scan to each lab's node when due; the
  // agent walks the datasets and reports counts back, stored in oldfile_scans.
  oldFileScanEnabled: boolean;
  oldFileScanIntervalDays: number; // scan each lab at most this often
  // External SMTP (no bundled mail server). Empty host disables email.
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean; // true = implicit TLS (465); false = STARTTLS/none
  // Optional public hostname students SSH to (falls back to the node name).
  sshHostOverride: string;
  // Welcome email sent to a student when added to a lab. Both fields support {placeholder}
  // substitution (see WELCOME_EMAIL_VARS / renderTemplate in lib/mailer.ts). Empty falls back to
  // the built-in default.
  welcomeEmailSubject: string;
  welcomeEmailBody: string;
  // GPU idle-kill policy (broadcast to agents as gpu.policy.update).
  gpuEnabled: boolean;
  gpuUtilThreshold: number;
  gpuIdleMinutes: number;
  gpuGraceMinutes: number;
  gpuImmediate: boolean;
  gpuWhitelistUsers: string; // comma-separated
  gpuWhitelistLabs: string; // comma-separated
  // Emails sent to a student when their idle GPU process is warned / terminated. Both support
  // {placeholder} substitution (see GPU_EMAIL_VARS / renderGpu*Email in lib/mailer.ts). Empty
  // falls back to the built-in default.
  gpuWarnEmailSubject: string;
  gpuWarnEmailBody: string;
  gpuKillEmailSubject: string;
  gpuKillEmailBody: string;
  // Alerting + logs.
  alertsEnabled: boolean;
  alertLevel: "WARN" | "ERROR"; // minimum log level that triggers an admin alert
  alertDedupMinutes: number; // suppress duplicate alerts (same key) within this window
  nodeOfflineGraceSeconds: number; // tolerate a node disconnect this long before alerting admins
  // Log rotation. The maintenance ticker (and a save of these settings) prunes the `logs` table to
  // satisfy all three caps, newest-wins. 0 means "no cap" for the respective dimension.
  logRetentionDays: number; // drop rows older than this many days
  logMaxEntries: number; // keep at most this many rows
  logMaxSizeMb: number; // keep the table's textual content under ~this many MB
  quotaAlertPct: number; // email the PI when a lab pool crosses this percent
  // WebDAV backup target. Backups are written under <webdavUrl>/<webdavBaseDir>/<env> where env is
  // "prod" or "dev" (derived from NODE_ENV) so a shared store keeps the two deployments separate.
  webdavUrl: string; // connection root, e.g. https://dav.example.com/dav
  webdavUser: string;
  webdavPass: string;
  webdavBaseDir: string; // collection under the root, e.g. /backups
  // Scheduled backups run every backupIntervalHours, aligned to an anchor time-of-day evaluated in
  // backupTimezone (so "daily at 02:00" survives DST). backupEnabled gates the scheduler.
  backupEnabled: boolean;
  backupIntervalHours: number; // hours between runs (must be > 0)
  backupAnchorHour: number; // 0-23, the time-of-day the schedule is aligned to
  backupAnchorMinute: number; // 0-59
  backupTimezone: string; // IANA tz the anchor time is evaluated in
  // Grandfather-father-son retention: keep the newest N, plus the newest backup in each of the most
  // recent N weeks, months, and years.
  backupKeepRecent: number;
  backupKeepWeekly: number;
  backupKeepMonthly: number;
  backupKeepYearly: number;
  // Last-run state, written by the backup runner and surfaced as status in the UI.
  backupLastRun: number; // epoch ms, 0 = never
  backupLastStatus: "" | "ok" | "failed";
  backupLastError: string;
  backupLastName: string;
  // Scheduled ZFS scrub. The controller enqueues node.scrub to each ZFS-capable node when due;
  // the agent reports scrub status/errors back via heartbeat telemetry.
  scrubEnabled: boolean;
  scrubIntervalDays: number; // scrub each node at most this often
  scrubHour: number; // hour of day (0-23, in scrubTimezone) at which scrubs may start
  scrubTimezone: string; // IANA tz name (e.g. "America/New_York") the scrub hour is evaluated in
}

/** Placeholders the welcome-email template understands, shown to the admin in the settings UI. */
export const WELCOME_EMAIL_VARS: { key: string; desc: string }[] = [
  { key: "name", desc: "student's full name (falls back to username)" },
  { key: "username", desc: "login username" },
  { key: "password", desc: "generated initial password" },
  { key: "host", desc: "SSH host (override or node name)" },
  { key: "port", desc: "SSH port" },
  { key: "lab", desc: "lab name" },
  { key: "node", desc: "node name the lab runs on" },
  { key: "student_id", desc: "student ID (may be blank)" },
  { key: "email", desc: "student's email address" },
];

export const DEFAULT_WELCOME_SUBJECT = "Your access to lab {lab}";

export const DEFAULT_WELCOME_BODY = `Hello {name},

You have been added to the lab "{lab}" on {node}. Connect over SSH:

    ssh {username}@{host} -p {port}

  Username: {username}
  Password: {password}

Your home directory contains:
  ~/scratch        fast storage for working data
  ~/cold-storage   slower storage for data you want to keep but rarely touch

Please change your password after first login (run: passwd).

— Lab Manager`;

/** Placeholders the GPU notification templates understand, shown to the admin in the settings UI. */
export const GPU_EMAIL_VARS: { key: string; desc: string }[] = [
  { key: "username", desc: "owner's login username" },
  { key: "pid", desc: "process id (may be blank)" },
  { key: "lab", desc: "lab name (may be blank)" },
  { key: "node", desc: "node the process runs on" },
  { key: "grace_minutes", desc: "minutes before termination (warning email only)" },
];

export const DEFAULT_GPU_WARN_SUBJECT = "Idle GPU process warning";

export const DEFAULT_GPU_WARN_BODY = `Hello {username},

One of your processes (PID {pid}) on node {node} is holding GPU memory but is not using the GPU.

If it stays idle it will be terminated in about {grace_minutes} minutes to free the GPU for others. If you still need it, start using the GPU again or contact an admin.

— Lab Manager`;

export const DEFAULT_GPU_KILL_SUBJECT = "Idle GPU process terminated";

export const DEFAULT_GPU_KILL_BODY = `Hello {username},

Your idle process (PID {pid}) on node {node} was terminated because it held GPU memory without using the GPU.

Please checkpoint long-running work and keep the GPU active, or ask an admin to whitelist your job.

— Lab Manager`;

export const DEFAULT_SETTINGS: Settings = {
  fastQuotaDefaultBytes: 2 * TIB,
  slowQuotaDefaultBytes: 3 * TIB,
  sshPortStart: 50000,
  sshPortEnd: 51000,
  oldFileThresholdDays: 30,
  oldFileScanEnabled: true,
  oldFileScanIntervalDays: 1,
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPass: "",
  smtpFrom: "",
  smtpSecure: false,
  sshHostOverride: "",
  welcomeEmailSubject: DEFAULT_WELCOME_SUBJECT,
  welcomeEmailBody: DEFAULT_WELCOME_BODY,
  gpuEnabled: false,
  gpuUtilThreshold: 5,
  gpuIdleMinutes: 20,
  gpuGraceMinutes: 10,
  gpuImmediate: false,
  gpuWhitelistUsers: "",
  gpuWhitelistLabs: "",
  gpuWarnEmailSubject: DEFAULT_GPU_WARN_SUBJECT,
  gpuWarnEmailBody: DEFAULT_GPU_WARN_BODY,
  gpuKillEmailSubject: DEFAULT_GPU_KILL_SUBJECT,
  gpuKillEmailBody: DEFAULT_GPU_KILL_BODY,
  alertsEnabled: true,
  alertLevel: "ERROR",
  alertDedupMinutes: 15,
  nodeOfflineGraceSeconds: 60,
  logRetentionDays: 30,
  logMaxEntries: 0,
  logMaxSizeMb: 0,
  quotaAlertPct: 90,
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  webdavBaseDir: "/backups",
  backupEnabled: false,
  backupIntervalHours: 24,
  backupAnchorHour: 2,
  backupAnchorMinute: 0,
  backupTimezone: "America/New_York",
  backupKeepRecent: 7,
  backupKeepWeekly: 4,
  backupKeepMonthly: 12,
  backupKeepYearly: 3,
  backupLastRun: 0,
  backupLastStatus: "",
  backupLastError: "",
  backupLastName: "",
  scrubEnabled: false,
  scrubIntervalDays: 30,
  scrubHour: 2,
  scrubTimezone: "UTC",
};

export function isWebdavConfigured(): boolean {
  return getSetting("webdavUrl").trim() !== "";
}

/** Which environment's backup collection this deployment reads/writes. */
export function backupEnv(): "prod" | "dev" {
  return env.isProd ? "prod" : "dev";
}

/**
 * The env-scoped WebDAV collection backups are written to: <webdavUrl>/<webdavBaseDir>/<env>.
 * All slashes are normalised so the parts join cleanly regardless of leading/trailing slashes.
 */
export function webdavConfig() {
  const root = getSetting("webdavUrl").trim().replace(/\/+$/, "");
  const base = getSetting("webdavBaseDir").trim().replace(/^\/+|\/+$/g, "");
  const url = [root, base, backupEnv()].filter(Boolean).join("/");
  return {
    url,
    user: getSetting("webdavUser"),
    pass: getSetting("webdavPass"),
  };
}

/** The GPU policy payload broadcast to agents (gpu.policy.update). */
export function gpuPolicyPayload(): Record<string, unknown> {
  const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    enabled: getSetting("gpuEnabled"),
    util_threshold: getSetting("gpuUtilThreshold"),
    idle_minutes: getSetting("gpuIdleMinutes"),
    grace_minutes: getSetting("gpuGraceMinutes"),
    immediate: getSetting("gpuImmediate"),
    whitelist_users: csv(getSetting("gpuWhitelistUsers")),
    whitelist_labs: csv(getSetting("gpuWhitelistLabs")),
  };
}

/** Enqueue the current GPU policy to every known node. */
export function broadcastGpuPolicy(actor?: string): void {
  const payload = gpuPolicyPayload();
  const nodes = db().prepare("SELECT name FROM nodes").all() as { name: string }[];
  for (const n of nodes) enqueueTask(n.name, "gpu.policy.update", payload, actor);
}

export function isSmtpConfigured(): boolean {
  return getSetting("smtpHost").trim() !== "" && getSetting("smtpFrom").trim() !== "";
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_SETTINGS[key];
  try {
    const parsed = JSON.parse(row.value) as Settings[K];
    if (ENCRYPTED_KEYS.has(key) && typeof parsed === "string") {
      return decryptSecret(parsed) as Settings[K];
    }
    return parsed;
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export function getSettings(): Settings {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    out[key] = getSetting(key) as never;
  }
  return out;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const toStore =
    ENCRYPTED_KEYS.has(key) && typeof value === "string"
      ? (encryptSecret(value) as Settings[K])
      : value;
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(toStore));
}

/** Pick the lowest SSH port in range not already assigned to a lab. */
export function nextSshPort(): number {
  const s = getSettings();
  const used = new Set(
    (db().prepare("SELECT ssh_port FROM labs WHERE ssh_port IS NOT NULL").all() as {
      ssh_port: number;
    }[]).map((r) => r.ssh_port),
  );
  for (let p = s.sshPortStart; p <= s.sshPortEnd; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("No free SSH port in the configured range");
}

/**
 * Operational settings, stored in the `settings` key/value table and editable in the UI.
 * Everything tunable at runtime lives here (quota defaults, SSH port range, usage-scan schedule,
 * and — added in later phases — SMTP, WebDAV, GPU policy, alert threshold).
 */

import { db } from "./db";
import { enqueueTask } from "./queue";
import { env } from "./env";
import { decryptSecret, encryptSecret } from "./secrets";

export const TIB = 1024 ** 4;

// Credential settings encrypted at rest (M-05). Stored AES-GCM-encrypted; decrypted on read.
const ENCRYPTED_KEYS = new Set<keyof Settings>(["smtpPass", "webdavPass"]);

export interface SmtpConfig {
  id: string;
  name: string;
  rank: number;
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

export interface Settings {
  fastQuotaDefaultBytes: number;
  slowQuotaDefaultBytes: number;
  sshPortStart: number;
  sshPortEnd: number;
  // Nightly per-student usage (du) scan. Once a day, during usageScanHour (in usageScanTimezone,
  // default midnight), the controller enqueues a usage.scan to each online lab's node; the agent
  // measures each student's persistent fast home and cold usage. Lab-level usage is separate
  // — the agent recomputes it on its own ~5-min cadence and it is not gated by this schedule.
  usageScanEnabled: boolean;
  usageScanHour: number; // hour of day (0-23, in usageScanTimezone) the nightly scan may start
  usageScanTimezone: string; // IANA tz name the usage-scan hour is evaluated in
  // External SMTP (no bundled mail server). Empty host disables email.
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean; // true = implicit TLS (465); false = STARTTLS/none
  // Ranked SMTP servers. An explicitly stored empty array disables SMTP. When this key has never
  // been stored, getSmtpConfigs() exposes the legacy single-server fields above for compatibility.
  smtpConfigs: SmtpConfig[];
  // Plain-text signature appended by the mailer to every outbound email.
  emailSignatureText: string;
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
  // Email sent to a student when they are removed from a lab. Supports {placeholder} substitution
  // (see REMOVAL_EMAIL_VARS / renderRemovalEmail in lib/mailer.ts). Empty falls back to the default.
  removalEmailSubject: string;
  removalEmailBody: string;
  // Email sent to a lab's PI when one of its pools crosses the quota-alert threshold. Supports
  // {placeholder} substitution (see QUOTA_EMAIL_VARS / renderQuotaEmail in lib/mailer.ts).
  quotaEmailSubject: string;
  quotaEmailBody: string;
  // The "Send test" email under Settings → Email. No variables. Empty falls back to the default.
  testEmailSubject: string;
  testEmailBody: string;
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
  ~                fast storage for working data
  ~/cold-storage   slower storage for data you want to keep but rarely touch

Please change your password after first login (run: passwd).`;

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

If it stays idle it will be terminated in about {grace_minutes} minutes to free the GPU for others. If you still need it, start using the GPU again or contact an admin.`;

export const DEFAULT_GPU_KILL_SUBJECT = "Idle GPU process terminated";

export const DEFAULT_GPU_KILL_BODY = `Hello {username},

Your idle process (PID {pid}) on node {node} was terminated because it held GPU memory without using the GPU.

Please checkpoint long-running work and keep the GPU active, or ask an admin to whitelist your job.`;

/** Placeholders the removal email understands, shown to the admin in the Templates UI. */
export const REMOVAL_EMAIL_VARS: { key: string; desc: string }[] = [
  { key: "lab", desc: "lab name the student was removed from" },
  { key: "data_status", desc: "sentence noting whether their data was deleted or retained" },
];

export const DEFAULT_REMOVAL_SUBJECT = "Removed from lab {lab}";

export const DEFAULT_REMOVAL_BODY = `You have been removed from the lab "{lab}". {data_status}`;

/** The two fixed sentences {data_status} resolves to (chosen by whether the data was deleted). */
export const REMOVAL_DATA_DELETED = "Your home and cold-storage data in this lab has been deleted.";
export const REMOVAL_DATA_RETAINED = "Your data has been retained for now; contact an admin if you need it.";

/** Placeholders the quota-alert email understands, shown to the admin in the Templates UI. */
export const QUOTA_EMAIL_VARS: { key: string; desc: string }[] = [
  { key: "lab", desc: "lab name" },
  { key: "pool", desc: "pool that crossed the threshold (fast/cold)" },
  { key: "pct", desc: "percent of quota used" },
  { key: "used", desc: "human-readable amount used" },
  { key: "quota", desc: "human-readable quota total" },
  { key: "breakdown", desc: "indented per-student usage lines for the pool" },
];

export const DEFAULT_QUOTA_SUBJECT = "Lab {lab} is at {pct}% of its {pool} quota";

export const DEFAULT_QUOTA_BODY = `Lab "{lab}" has reached {pct}% of its {pool} storage quota ({used} of {quota}).

Per-student usage on the {pool} pool:
{breakdown}

You may want to ask students to clean up unneeded data, or request a larger quota.`;

export const DEFAULT_TEST_SUBJECT = "Lab Manager test email";

export const DEFAULT_TEST_BODY =
  "This is a test email from the Lab Manager controller. SMTP is configured correctly.";

/** Default plain-text signature used unless an admin replaces it on the Templates page. */
export const DEFAULT_EMAIL_SIGNATURE_TEXT = `Ningxi Cheng, Graduate Research Assistant
School of Computing | Ph.D. Student
edwardcheng@uga.edu
University of Georgia`;

export const DEFAULT_SETTINGS: Settings = {
  fastQuotaDefaultBytes: 2 * TIB,
  slowQuotaDefaultBytes: 3 * TIB,
  sshPortStart: 50000,
  sshPortEnd: 51000,
  usageScanEnabled: true,
  usageScanHour: 0, // midnight (in usageScanTimezone)
  usageScanTimezone: "UTC",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPass: "",
  smtpFrom: "",
  smtpSecure: false,
  smtpConfigs: [],
  emailSignatureText: DEFAULT_EMAIL_SIGNATURE_TEXT,
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
  removalEmailSubject: DEFAULT_REMOVAL_SUBJECT,
  removalEmailBody: DEFAULT_REMOVAL_BODY,
  quotaEmailSubject: DEFAULT_QUOTA_SUBJECT,
  quotaEmailBody: DEFAULT_QUOTA_BODY,
  testEmailSubject: DEFAULT_TEST_SUBJECT,
  testEmailBody: DEFAULT_TEST_BODY,
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
  return getSmtpConfigs().some((config) => config.host !== "" && config.from !== "");
}

/** Return every SMTP config in failover order (lowest rank is attempted first). */
export function getSmtpConfigs(): SmtpConfig[] {
  const hasRankedConfigs = !!db().prepare("SELECT 1 FROM settings WHERE key = 'smtpConfigs'").get();
  if (hasRankedConfigs) {
    return getSetting("smtpConfigs")
      .filter((config) => config && typeof config === "object")
      .map((config, index) => ({
        id: String(config.id || `smtp-${index + 1}`),
        name: String(config.name || `SMTP ${index + 1}`),
        rank: Number.isFinite(Number(config.rank)) ? Math.max(1, Math.trunc(Number(config.rank))) : index + 1,
        host: String(config.host || "").trim(),
        port: Number(config.port) > 0 ? Math.trunc(Number(config.port)) : 587,
        user: String(config.user || "").trim(),
        pass: String(config.pass || ""),
        from: String(config.from || "").trim(),
        secure: !!config.secure,
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  const host = getSetting("smtpHost").trim();
  const from = getSetting("smtpFrom").trim();
  if (!host && !from) return [];
  return [{
    id: "legacy",
    name: "Primary SMTP",
    rank: 1,
    host,
    port: getSetting("smtpPort"),
    user: getSetting("smtpUser").trim(),
    pass: getSetting("smtpPass"),
    from,
    secure: getSetting("smtpSecure"),
  }];
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_SETTINGS[key];
  try {
    const parsed = JSON.parse(row.value) as Settings[K];
    if (key === "smtpConfigs" && Array.isArray(parsed)) {
      return parsed.map((config) => ({
        ...config,
        pass: typeof config?.pass === "string" ? decryptSecret(config.pass) : "",
      })) as Settings[K];
    }
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
  const toStore = key === "smtpConfigs" && Array.isArray(value)
    ? value.map((config) => ({ ...config, pass: encryptSecret(config.pass) }))
    : ENCRYPTED_KEYS.has(key) && typeof value === "string"
      ? (encryptSecret(value) as Settings[K])
      : value;
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(toStore));
}

// SSH-port allocation is per node (placements own the port) — see nextSshPortForNode in placements.ts.

/**
 * Operational settings, stored in the `settings` key/value table and editable in the UI.
 * Everything tunable at runtime lives here (quota defaults, SSH port range, old-file threshold,
 * and — added in later phases — SMTP, WebDAV, GPU policy, alert threshold).
 */

import { db } from "./db";
import { enqueueTask } from "./queue";
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
  // Alerting + logs.
  alertsEnabled: boolean;
  alertLevel: "WARN" | "ERROR"; // minimum log level that triggers an admin alert
  alertDedupMinutes: number; // suppress duplicate alerts (same key) within this window
  nodeOfflineGraceSeconds: number; // tolerate a node disconnect this long before alerting admins
  logRetentionDays: number;
  quotaAlertPct: number; // email the PI when a lab pool crosses this percent
  // WebDAV backup target.
  webdavUrl: string; // e.g. https://dav.example.com/labmgr
  webdavUser: string;
  webdavPass: string;
  webdavRetention: number; // keep this many timestamped backups
  backupIntervalHours: number; // 0 disables scheduled backups
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
  alertsEnabled: true,
  alertLevel: "ERROR",
  alertDedupMinutes: 15,
  nodeOfflineGraceSeconds: 60,
  logRetentionDays: 30,
  quotaAlertPct: 90,
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  webdavRetention: 7,
  backupIntervalHours: 24,
  scrubEnabled: false,
  scrubIntervalDays: 30,
  scrubHour: 2,
  scrubTimezone: "UTC",
};

export function isWebdavConfigured(): boolean {
  return getSetting("webdavUrl").trim() !== "";
}

export function webdavConfig() {
  return {
    url: getSetting("webdavUrl").trim().replace(/\/$/, ""),
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

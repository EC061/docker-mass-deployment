/**
 * Operational settings, stored in the `settings` key/value table and editable in the UI.
 * Everything tunable at runtime lives here (quota defaults, SSH port range, old-file threshold,
 * and — added in later phases — SMTP, WebDAV, GPU policy, alert threshold).
 */

import { db } from "./db";
import { enqueueTask } from "./queue";

export const TIB = 1024 ** 4;

export interface Settings {
  fastQuotaDefaultBytes: number;
  slowQuotaDefaultBytes: number;
  sshPortStart: number;
  sshPortEnd: number;
  oldFileThresholdDays: number;
  // External SMTP (no bundled mail server). Empty host disables email.
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean; // true = implicit TLS (465); false = STARTTLS/none
  // Optional public hostname students SSH to (falls back to the node name).
  sshHostOverride: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  fastQuotaDefaultBytes: 2 * TIB,
  slowQuotaDefaultBytes: 3 * TIB,
  sshPortStart: 50000,
  sshPortEnd: 51000,
  oldFileThresholdDays: 30,
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPass: "",
  smtpFrom: "",
  smtpSecure: false,
  sshHostOverride: "",
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
  logRetentionDays: 30,
  quotaAlertPct: 90,
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  webdavRetention: 7,
  backupIntervalHours: 24,
  scrubEnabled: false,
  scrubIntervalDays: 30,
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
    return JSON.parse(row.value) as Settings[K];
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
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
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

"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sendTestEmail } from "@/lib/mailer";
import { broadcastGpuPolicy, getSmtpConfigs, setSetting, TIB } from "@/lib/settings";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { pruneLogs } from "@/lib/maintenance";

export async function saveStorageSettingsAction(formData: FormData) {
  await requireAdmin();
  const fastTb = Number(formData.get("fastTb"));
  const slowTb = Number(formData.get("slowTb"));
  const portStart = Number(formData.get("sshPortStart"));
  const portEnd = Number(formData.get("sshPortEnd"));

  if (fastTb > 0) setSetting("fastQuotaDefaultBytes", Math.round(fastTb * TIB));
  if (slowTb > 0) setSetting("slowQuotaDefaultBytes", Math.round(slowTb * TIB));
  if (portStart > 0) setSetting("sshPortStart", portStart);
  if (portEnd > portStart) setSetting("sshPortEnd", portEnd);

  revalidatePath("/settings");
}

/** Save the nightly per-student usage (du) scan schedule (mirrors saveScrubSettingsAction). */
export async function saveUsageScanSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("usageScanEnabled", formData.get("usageScanEnabled") === "on");
  const hour = Number(formData.get("usageScanHour"));
  setSetting("usageScanHour", Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.trunc(hour) : 3);
  const tz = String(formData.get("usageScanTimezone") ?? "").trim();
  // Validate the IANA name by round-tripping it through Intl; reject anything DateTimeFormat won't take.
  let validTz = "UTC";
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      validTz = tz;
    }
  } catch {
    validTz = "UTC";
  }
  setSetting("usageScanTimezone", validTz);
  revalidatePath("/settings");
}

// Implicit TLS is no longer a manual toggle: it's inferred from the SMTP host.
// An https:// scheme (or port 465) means implicit TLS; http:// (or any other
// port) means STARTTLS/none. The scheme and any embedded port are stripped so a
// bare hostname is stored for nodemailer.
function parseSmtpHost(
  raw: string,
  portField: number,
): { host: string; port: number; secure: boolean } {
  let input = raw.trim();
  let scheme: "http" | "https" | null = null;
  const m = input.match(/^(https?):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase() as "http" | "https";
    input = input.slice(m[0].length);
  }
  // Drop any trailing path/query.
  input = input.split(/[/?#]/)[0];
  // Pull an embedded port (host:port) out of the host string; it wins over the field.
  let port = portField;
  const colon = input.lastIndexOf(":");
  if (colon !== -1) {
    const p = Number(input.slice(colon + 1));
    if (p > 0) port = p;
    input = input.slice(0, colon);
  }
  const secure = scheme === "https" ? true : scheme === "http" ? false : port === 465;
  return { host: input.trim(), port, secure };
}

export async function saveSmtpSettingsAction(formData: FormData) {
  await requireAdmin();
  const { host, port, secure } = parseSmtpHost(
    String(formData.get("smtpHost") ?? ""),
    Number(formData.get("smtpPort")) || 587,
  );
  const configs = getSmtpConfigs();
  const id = String(formData.get("smtpId") ?? "").trim() || randomUUID();
  const existing = configs.find((config) => config.id === id);
  const pass = String(formData.get("smtpPass") ?? "");
  const rankValue = Number(formData.get("smtpRank"));
  const rank = Number.isFinite(rankValue) && rankValue > 0
    ? Math.trunc(rankValue)
    : existing?.rank ?? Math.max(0, ...configs.map((config) => config.rank)) + 1;
  const updated = {
    id,
    name: String(formData.get("smtpName") ?? "").trim() || `SMTP ${rank}`,
    rank,
    host,
    port,
    secure,
    user: String(formData.get("smtpUser") ?? "").trim(),
    pass: pass || existing?.pass || "",
    from: String(formData.get("smtpFrom") ?? "").trim(),
  };
  setSetting("smtpConfigs", existing
    ? configs.map((config) => config.id === id ? updated : config)
    : [...configs, updated]);
  revalidatePath("/settings");
}

export async function deleteSmtpSettingsAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("smtpId") ?? "");
  const configs = getSmtpConfigs();
  const removed = configs.find((config) => config.id === id);
  setSetting("smtpConfigs", configs.filter((config) => config.id !== id));
  revalidatePath("/settings");
  redirect(`/settings?smtp=${encodeURIComponent(removed ? `Deleted ${removed.name}` : "SMTP server deleted")}`);
}

export async function saveAlertSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("alertsEnabled", formData.get("alertsEnabled") === "on");
  const level = String(formData.get("alertLevel") ?? "ERROR");
  setSetting("alertLevel", level === "WARN" ? "WARN" : "ERROR");
  setSetting("alertDedupMinutes", Number(formData.get("alertDedupMinutes")) || 15);
  const grace = Number(formData.get("nodeOfflineGraceSeconds"));
  setSetting("nodeOfflineGraceSeconds", Number.isFinite(grace) && grace >= 0 ? Math.trunc(grace) : 60);
  setSetting("logRetentionDays", Number(formData.get("logRetentionDays")) || 30);
  // Log rotation caps: 0 (or invalid) means "no cap". Apply them right away so the admin sees the
  // effect immediately rather than waiting for the next hourly maintenance tick.
  const maxEntries = Number(formData.get("logMaxEntries"));
  setSetting("logMaxEntries", Number.isFinite(maxEntries) && maxEntries > 0 ? Math.trunc(maxEntries) : 0);
  const maxSizeMb = Number(formData.get("logMaxSizeMb"));
  setSetting("logMaxSizeMb", Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 0);
  setSetting("quotaAlertPct", Number(formData.get("quotaAlertPct")) || 90);
  setSetting("studentQuotaAlertsEnabled", formData.get("studentQuotaAlertsEnabled") === "on");
  const studentPct = Number(formData.get("studentQuotaAlertPct"));
  setSetting("studentQuotaAlertPct",
    Number.isFinite(studentPct) && studentPct > 0 && studentPct <= 100 ? studentPct : 50);
  setSetting("studentQuotaNotifyAdmins", formData.get("studentQuotaNotifyAdmins") === "on");
  pruneLogs();
  revalidatePath("/settings");
}

/** Purge every row from the `logs` table (the "Delete all logs" button). */
export async function clearLogsAction() {
  await requireAdmin();
  const n = db().prepare("DELETE FROM logs").run().changes;
  redirect(`/settings?logs=${encodeURIComponent(`Deleted ${n.toLocaleString()} log ${n === 1 ? "entry" : "entries"}`)}`);
}

export async function saveGpuPolicyAction(formData: FormData) {
  const who = (await requireAdmin()).email;
  setSetting("gpuEnabled", formData.get("gpuEnabled") === "on");
  setSetting("gpuImmediate", formData.get("gpuImmediate") === "on");
  setSetting("gpuUtilThreshold", Number(formData.get("gpuUtilThreshold")) || 5);
  setSetting("gpuIdleMinutes", Number(formData.get("gpuIdleMinutes")) || 20);
  setSetting("gpuGraceMinutes", Number(formData.get("gpuGraceMinutes")) || 10);
  setSetting("gpuWhitelistUsers", String(formData.get("gpuWhitelistUsers") ?? "").trim());
  setSetting("gpuWhitelistLabs", String(formData.get("gpuWhitelistLabs") ?? "").trim());
  // Push the new policy to every node immediately.
  broadcastGpuPolicy(who);
  revalidatePath("/settings");
}

export async function saveScrubSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("scrubEnabled", formData.get("scrubEnabled") === "on");
  setSetting("scrubIntervalDays", Number(formData.get("scrubIntervalDays")) || 30);
  const hour = Number(formData.get("scrubHour"));
  setSetting("scrubHour", Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.trunc(hour) : 2);
  const tz = String(formData.get("scrubTimezone") ?? "").trim();
  // Validate the IANA name by round-tripping it through Intl; reject anything DateTimeFormat won't take.
  let validTz = "UTC";
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      validTz = tz;
    }
  } catch {
    validTz = "UTC";
  }
  setSetting("scrubTimezone", validTz);
  revalidatePath("/settings");
}

export async function scrubNowAction() {
  const actor = (await requireAdmin()).email;
  const { db } = await import("@/lib/db");
  const { enqueueTask } = await import("@/lib/queue");
  const nodes = db()
    .prepare("SELECT name, capabilities FROM nodes WHERE online = 1")
    .all() as { name: string; capabilities: string | null }[];
  let count = 0;
  for (const n of nodes) {
    let zfs = false;
    try {
      zfs = !!(n.capabilities && JSON.parse(n.capabilities).zfs);
    } catch {
      zfs = false;
    }
    if (!zfs) continue;
    enqueueTask(n.name, "node.scrub", {}, actor);
    db().prepare("UPDATE nodes SET last_scrub = ? WHERE name = ?").run(Date.now(), n.name);
    count++;
  }
  redirect(`/settings?scrub=${encodeURIComponent(`Scrub started on ${count} node(s)`)}`);
}

export async function testEmailAction(formData: FormData) {
  await requireAdmin();
  const to = String(formData.get("to") ?? "").trim();
  const res = await sendTestEmail(to);
  const msg = res.sent
    ? "Test email sent"
    : res.skipped
      ? "SMTP not configured"
      : `Failed: ${res.error}`;
  redirect(`/settings?smtp=${encodeURIComponent(msg)}`);
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sendTestEmail } from "@/lib/mailer";
import { broadcastGpuPolicy, setSetting, TIB } from "@/lib/settings";
import { requireAdmin } from "@/lib/auth";

export async function saveStorageSettingsAction(formData: FormData) {
  await requireAdmin();
  const fastTb = Number(formData.get("fastTb"));
  const slowTb = Number(formData.get("slowTb"));
  const portStart = Number(formData.get("sshPortStart"));
  const portEnd = Number(formData.get("sshPortEnd"));
  const threshold = Number(formData.get("oldFileThresholdDays"));
  const scanInterval = Number(formData.get("oldFileScanIntervalDays"));

  if (fastTb > 0) setSetting("fastQuotaDefaultBytes", Math.round(fastTb * TIB));
  if (slowTb > 0) setSetting("slowQuotaDefaultBytes", Math.round(slowTb * TIB));
  if (portStart > 0) setSetting("sshPortStart", portStart);
  if (portEnd > portStart) setSetting("sshPortEnd", portEnd);
  if (threshold > 0) setSetting("oldFileThresholdDays", threshold);
  setSetting("oldFileScanEnabled", formData.get("oldFileScanEnabled") === "on");
  if (scanInterval > 0) setSetting("oldFileScanIntervalDays", scanInterval);

  revalidatePath("/settings");
}

export async function saveSmtpSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("smtpHost", String(formData.get("smtpHost") ?? "").trim());
  setSetting("smtpPort", Number(formData.get("smtpPort")) || 587);
  setSetting("smtpUser", String(formData.get("smtpUser") ?? "").trim());
  const pass = String(formData.get("smtpPass") ?? "");
  // Only overwrite the stored password when a new one is entered (the field renders blank).
  if (pass) setSetting("smtpPass", pass);
  setSetting("smtpFrom", String(formData.get("smtpFrom") ?? "").trim());
  setSetting("smtpSecure", formData.get("smtpSecure") === "on");
  setSetting("sshHostOverride", String(formData.get("sshHostOverride") ?? "").trim());
  revalidatePath("/settings");
}

export async function saveAlertSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("alertsEnabled", formData.get("alertsEnabled") === "on");
  const level = String(formData.get("alertLevel") ?? "ERROR");
  setSetting("alertLevel", level === "WARN" ? "WARN" : "ERROR");
  setSetting("alertDedupMinutes", Number(formData.get("alertDedupMinutes")) || 15);
  setSetting("logRetentionDays", Number(formData.get("logRetentionDays")) || 30);
  setSetting("quotaAlertPct", Number(formData.get("quotaAlertPct")) || 90);
  revalidatePath("/settings");
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

export async function saveWebdavSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("webdavUrl", String(formData.get("webdavUrl") ?? "").trim());
  setSetting("webdavUser", String(formData.get("webdavUser") ?? "").trim());
  const pass = String(formData.get("webdavPass") ?? "");
  if (pass) setSetting("webdavPass", pass);
  setSetting("webdavRetention", Number(formData.get("webdavRetention")) || 7);
  setSetting("backupIntervalHours", Number(formData.get("backupIntervalHours")) || 0);
  revalidatePath("/settings");
}

export async function backupNowAction() {
  await requireAdmin();
  const { backupAll } = await import("@/lib/backup");
  const res = await backupAll();
  redirect(`/settings?backup=${encodeURIComponent(res.ok ? `Backed up ${res.name}` : `Failed: ${res.error}`)}`);
}

export async function restoreAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "");
  const { stageRestore } = await import("@/lib/backup");
  const res = await stageRestore(name);
  const msg = res.ok
    ? "Restore staged — restart the controller to apply it"
    : `Failed: ${res.error}`;
  redirect(`/settings?backup=${encodeURIComponent(msg)}`);
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

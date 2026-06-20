"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sendTestEmail } from "@/lib/mailer";
import { broadcastGpuPolicy, setSetting, TIB } from "@/lib/settings";
import { currentAdmin } from "@/lib/auth";

export async function saveStorageSettingsAction(formData: FormData) {
  const fastTb = Number(formData.get("fastTb"));
  const slowTb = Number(formData.get("slowTb"));
  const portStart = Number(formData.get("sshPortStart"));
  const portEnd = Number(formData.get("sshPortEnd"));
  const threshold = Number(formData.get("oldFileThresholdDays"));

  if (fastTb > 0) setSetting("fastQuotaDefaultBytes", Math.round(fastTb * TIB));
  if (slowTb > 0) setSetting("slowQuotaDefaultBytes", Math.round(slowTb * TIB));
  if (portStart > 0) setSetting("sshPortStart", portStart);
  if (portEnd > portStart) setSetting("sshPortEnd", portEnd);
  if (threshold > 0) setSetting("oldFileThresholdDays", threshold);

  revalidatePath("/settings");
}

export async function saveSmtpSettingsAction(formData: FormData) {
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

export async function saveGpuPolicyAction(formData: FormData) {
  setSetting("gpuEnabled", formData.get("gpuEnabled") === "on");
  setSetting("gpuImmediate", formData.get("gpuImmediate") === "on");
  setSetting("gpuUtilThreshold", Number(formData.get("gpuUtilThreshold")) || 5);
  setSetting("gpuIdleMinutes", Number(formData.get("gpuIdleMinutes")) || 20);
  setSetting("gpuGraceMinutes", Number(formData.get("gpuGraceMinutes")) || 10);
  setSetting("gpuWhitelistUsers", String(formData.get("gpuWhitelistUsers") ?? "").trim());
  setSetting("gpuWhitelistLabs", String(formData.get("gpuWhitelistLabs") ?? "").trim());
  // Push the new policy to every node immediately.
  broadcastGpuPolicy((await currentAdmin())?.email);
  revalidatePath("/settings");
}

export async function testEmailAction(formData: FormData) {
  const to = String(formData.get("to") ?? "").trim();
  const res = await sendTestEmail(to);
  const msg = res.sent
    ? "Test email sent"
    : res.skipped
      ? "SMTP not configured"
      : `Failed: ${res.error}`;
  redirect(`/settings?smtp=${encodeURIComponent(msg)}`);
}

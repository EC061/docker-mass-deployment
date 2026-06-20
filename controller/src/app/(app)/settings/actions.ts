"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sendTestEmail } from "@/lib/mailer";
import { setSetting, TIB } from "@/lib/settings";

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

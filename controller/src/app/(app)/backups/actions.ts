"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { setSetting } from "@/lib/settings";

function done(msg: string): never {
  redirect(`/backups?msg=${encodeURIComponent(msg)}`);
}

export async function saveWebdavSettingsAction(formData: FormData) {
  await requireAdmin();
  setSetting("webdavUrl", String(formData.get("webdavUrl") ?? "").trim());
  setSetting("webdavUser", String(formData.get("webdavUser") ?? "").trim());
  const pass = String(formData.get("webdavPass") ?? "");
  // The password field renders blank; only overwrite the stored secret when a new one is entered.
  if (pass) setSetting("webdavPass", pass);
  const base = String(formData.get("webdavBaseDir") ?? "").trim() || "/backups";
  setSetting("webdavBaseDir", base);
  done("Configuration saved");
}

export async function saveScheduleAction(formData: FormData) {
  await requireAdmin();
  setSetting("backupEnabled", formData.get("backupEnabled") === "on");
  setSetting("backupIntervalHours", Number(formData.get("backupIntervalHours")) || 24);

  // Anchor time arrives as "HH:MM" from an <input type="time">.
  const [h, m] = String(formData.get("backupAnchor") ?? "02:00").split(":").map(Number);
  setSetting("backupAnchorHour", Number.isInteger(h) && h >= 0 && h <= 23 ? h : 2);
  setSetting("backupAnchorMinute", Number.isInteger(m) && m >= 0 && m <= 59 ? m : 0);

  const tz = String(formData.get("backupTimezone") ?? "").trim();
  let validTz = "UTC";
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      validTz = tz;
    }
  } catch {
    validTz = "UTC";
  }
  setSetting("backupTimezone", validTz);

  const nonNeg = (name: string, fallback: number) => {
    const n = Number(formData.get(name));
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
  };
  setSetting("backupKeepRecent", nonNeg("backupKeepRecent", 7));
  setSetting("backupKeepWeekly", nonNeg("backupKeepWeekly", 4));
  setSetting("backupKeepMonthly", nonNeg("backupKeepMonthly", 12));
  setSetting("backupKeepYearly", nonNeg("backupKeepYearly", 3));
  done("Schedule saved");
}

export async function testConnectionAction() {
  await requireAdmin();
  const { testConnection } = await import("@/lib/backup");
  const res = await testConnection();
  done(res.ok ? "Connection OK" : `Connection failed: ${res.error}`);
}

export async function backupNowAction() {
  await requireAdmin();
  const { backupAll } = await import("@/lib/backup");
  const res = await backupAll();
  done(res.ok ? `Backed up ${res.name}` : `Backup failed: ${res.error}`);
}

export async function restoreAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "");
  const { stageRestore } = await import("@/lib/backup");
  const res = await stageRestore(name);
  done(
    res.ok
      ? "Restore staged — restart the controller to apply it"
      : `Restore failed: ${res.error}`,
  );
}

export async function refreshAction() {
  await requireAdmin();
  revalidatePath("/backups");
  redirect("/backups");
}

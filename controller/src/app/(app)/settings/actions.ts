"use server";

import { revalidatePath } from "next/cache";
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

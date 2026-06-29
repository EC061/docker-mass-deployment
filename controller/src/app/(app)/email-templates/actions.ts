"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import {
  createAnnouncementTemplate,
  deleteAnnouncementTemplate,
  updateAnnouncementTemplate,
} from "@/lib/announcements";
import { putFlash } from "@/lib/flash";

// Every email the controller can send is edited here. Subjects are trimmed (a blank field falls back
// to the built-in default at render time); bodies are stored verbatim so intentional leading/trailing
// whitespace in a template is preserved. Each save revalidates the Templates page.

export async function saveWelcomeEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("welcomeEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("welcomeEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

export async function saveGpuWarnEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("gpuWarnEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("gpuWarnEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

export async function saveGpuKillEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("gpuKillEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("gpuKillEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

export async function saveRemovalEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("removalEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("removalEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

export async function saveQuotaEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("quotaEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("quotaEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

export async function saveTestEmailAction(formData: FormData) {
  await requireAdmin();
  setSetting("testEmailSubject", String(formData.get("subject") ?? "").trim());
  setSetting("testEmailBody", String(formData.get("body") ?? ""));
  revalidatePath("/email-templates");
}

/** Run an announcement-template mutation, surfacing any error as a flash on the Templates page. */
async function withTemplateFlash(fn: () => void): Promise<void> {
  await requireAdmin();
  try {
    fn();
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not save announcement template");
    redirect(`/email-templates?error=${fid}`);
  }
  revalidatePath("/email-templates");
  revalidatePath("/announcements");
}

export async function createAnnouncementTemplateAction(formData: FormData) {
  await withTemplateFlash(() =>
    createAnnouncementTemplate({
      name: String(formData.get("name") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
    }),
  );
}

export async function updateAnnouncementTemplateAction(formData: FormData) {
  const id = Number(formData.get("id"));
  await withTemplateFlash(() =>
    updateAnnouncementTemplate(id, {
      name: String(formData.get("name") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
    }),
  );
}

export async function deleteAnnouncementTemplateAction(formData: FormData) {
  const id = Number(formData.get("id"));
  await withTemplateFlash(() => deleteAnnouncementTemplate(id));
}

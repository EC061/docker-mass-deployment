"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { clearAnnouncements, deleteAnnouncement, sendAnnouncement, type Audience } from "@/lib/announcements";

export async function sendAnnouncementAction(formData: FormData) {
  const admin = await requireAdmin();
  const subject = String(formData.get("subject") ?? "");
  const body = String(formData.get("body") ?? "");
  const audiences: Audience[] = [];
  if (formData.get("students") === "on") audiences.push("students");
  if (formData.get("pis") === "on") audiences.push("pis");
  const individuals = formData.getAll("recipient").map(String);
  // Placeholder values arrive as ph_<TOKEN> fields, one per [BRACKET] span in the subject/body.
  const placeholders: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("ph_")) placeholders[key.slice(3)] = String(value);
  }

  let msg: string;
  try {
    const res = await sendAnnouncement({
      subject,
      body,
      audiences,
      individuals,
      placeholders,
      sender: { name: admin.name, email: admin.email },
      actor: admin.email,
    });
    msg = res.skipped
      ? `SMTP not configured — nothing sent (${res.recipients} recipient(s) would have been targeted)`
      : `Sent to ${res.sent} of ${res.recipients} recipient(s)`;
  } catch (e) {
    msg = e instanceof Error ? e.message : "could not send announcement";
  }
  redirect("/announcements?msg=" + encodeURIComponent(msg));
}

export async function deleteAnnouncementAction(formData: FormData) {
  const admin = await requireAdmin();
  let msg: string;
  try {
    deleteAnnouncement(Number(formData.get("id")), admin.email);
    msg = "Announcement deleted";
  } catch (e) {
    msg = e instanceof Error ? e.message : "could not delete announcement";
  }
  revalidatePath("/announcements");
  redirect("/announcements?msg=" + encodeURIComponent(msg));
}

export async function clearAnnouncementsAction() {
  const admin = await requireAdmin();
  const cleared = clearAnnouncements(admin.email);
  revalidatePath("/announcements");
  redirect(
    "/announcements?msg=" +
      encodeURIComponent(`Cleared ${cleared} announcement${cleared === 1 ? "" : "s"}`),
  );
}

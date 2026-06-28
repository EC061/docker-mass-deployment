"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { sendAnnouncement, type Audience } from "@/lib/announcements";

export async function sendAnnouncementAction(formData: FormData) {
  const admin = await requireAdmin();
  const subject = String(formData.get("subject") ?? "");
  const body = String(formData.get("body") ?? "");
  const audiences: Audience[] = [];
  if (formData.get("students") === "on") audiences.push("students");
  if (formData.get("pis") === "on") audiences.push("pis");

  let msg: string;
  try {
    const res = await sendAnnouncement({ subject, body, audiences, actor: admin.email });
    msg = res.skipped
      ? `SMTP not configured — nothing sent (${res.recipients} recipient(s) would have been targeted)`
      : `Sent to ${res.sent} of ${res.recipients} recipient(s)`;
  } catch (e) {
    msg = e instanceof Error ? e.message : "could not send announcement";
  }
  redirect("/announcements?msg=" + encodeURIComponent(msg));
}

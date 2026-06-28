/**
 * Service announcements: an admin composes a message and broadcasts it by email to all students
 * and/or all PIs. Each send is recorded in the `announcements` table for an audit trail and shown
 * as recent history on the Announcements page.
 *
 * Recipients are deduped across audiences (a PI who is also a student is mailed once). If SMTP is not
 * configured the send is recorded as skipped and nothing goes out, mirroring the rest of the mailer.
 */

import { audit } from "./labs";
import { db } from "./db";
import { sendMail } from "./mailer";
import { isSmtpConfigured } from "./settings";

export type Audience = "students" | "pis";

/** Distinct, non-empty email addresses for the given audience. */
function audienceEmails(audience: Audience): string[] {
  const sql =
    audience === "students"
      ? "SELECT DISTINCT email FROM students WHERE email IS NOT NULL AND TRIM(email) <> ''"
      : "SELECT DISTINCT pi_email AS email FROM labs WHERE pi_email IS NOT NULL AND TRIM(pi_email) <> ''";
  return (db().prepare(sql).all() as { email: string }[]).map((r) => r.email.trim()).filter(Boolean);
}

/** How many addressable recipients each audience currently has (for the compose UI). */
export function audienceCounts(): { students: number; pis: number } {
  return {
    students: audienceEmails("students").length,
    pis: audienceEmails("pis").length,
  };
}

export interface AnnouncementRow {
  id: number;
  ts: number;
  actor: string | null;
  audiences: string;
  subject: string;
  body: string;
  recipients: number;
  sent: number;
  skipped: number;
}

export function recentAnnouncements(limit = 20): AnnouncementRow[] {
  return db()
    .prepare("SELECT * FROM announcements ORDER BY ts DESC LIMIT ?")
    .all(limit) as AnnouncementRow[];
}

export interface AnnouncementResult {
  recipients: number;
  sent: number;
  skipped: boolean;
}

/**
 * Send an announcement to the union of the selected audiences. Returns recipient/sent counts.
 * Always records a row (even when skipped or zero recipients) so the history reflects every attempt.
 */
export async function sendAnnouncement(input: {
  subject: string;
  body: string;
  audiences: Audience[];
  actor?: string;
}): Promise<AnnouncementResult> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject) throw new Error("subject is required");
  if (!body) throw new Error("message is required");
  if (input.audiences.length === 0) throw new Error("pick at least one audience");

  const recipients = [...new Set(input.audiences.flatMap(audienceEmails))];
  const skipped = !isSmtpConfigured();

  const text = `${body}\n\n— Lab Manager`;
  let sent = 0;
  if (!skipped) {
    const results = await Promise.all(recipients.map((to) => sendMail(to, subject, text)));
    sent = results.filter((r) => r.sent).length;
  }

  db()
    .prepare(
      `INSERT INTO announcements (ts, actor, audiences, subject, body, recipients, sent, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      input.actor ?? null,
      input.audiences.join(","),
      subject,
      body,
      recipients.length,
      sent,
      skipped ? 1 : 0,
    );
  audit(input.actor, "announcement.send", input.audiences.join(","), `${sent}/${recipients.length} sent`);

  return { recipients: recipients.length, sent, skipped };
}

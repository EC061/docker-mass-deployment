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
import { renderTemplate } from "./template";

export type Audience = "students" | "pis";

/** A resolved recipient: the email plus a best-effort display name for {name} substitution. */
export interface Recipient {
  email: string;
  name: string;
}

/** Placeholders an announcement template understands, rendered per recipient. */
export const ANNOUNCEMENT_VARS: { key: string; desc: string }[] = [
  { key: "name", desc: "recipient's name (falls back to username, then email)" },
  { key: "email", desc: "recipient's email address" },
];

export interface AnnouncementTemplate {
  name: string;
  subject: string;
  body: string;
}

/** Prebuilt starting points for the compose form. Edit freely before sending; {tokens} render per
 * recipient and ALL-CAPS bracketed spans are placeholders for the admin to fill in by hand. */
export const ANNOUNCEMENT_TEMPLATES: AnnouncementTemplate[] = [
  {
    name: "Scheduled maintenance",
    subject: "Scheduled maintenance on [DATE]",
    body: `Hello {name},

The lab cluster will be unavailable for scheduled maintenance on [DATE] from [START] to [END] ([TIMEZONE]).

Please save your work and log out before the window begins. Long-running jobs should be checkpointed or paused — anything still running may be interrupted.

We'll email again once everything is back online.`,
  },
  {
    name: "Storage cleanup request",
    subject: "Action needed: free up storage in your lab",
    body: `Hello {name},

Storage on the cluster is running low. Please review the data in your scratch and cold-storage directories and remove anything you no longer need.

You can check your usage by logging in and running:
    du -sh ~/scratch ~/cold-storage

Thanks for helping keep the cluster healthy.`,
  },
  {
    name: "New capacity available",
    subject: "New compute capacity available",
    body: `Hello {name},

We've added new capacity to the cluster. If your work has been waiting on resources, you should now have more room to run jobs.

Let us know if you'd like help making use of it.`,
  },
  {
    name: "Access expiring",
    subject: "Your cluster access expires on [DATE]",
    body: `Hello {name},

Your access to the lab cluster ({email}) is scheduled to end on [DATE].

If you need to keep your account active, please reply to this message before then. After that date your account and data may be removed.`,
  },
];

/** Distinct recipients (email + display name) for the given audience, deduped by email. */
function audienceRecipients(audience: Audience): Recipient[] {
  const sql =
    audience === "students"
      ? "SELECT email, name, username FROM students WHERE email IS NOT NULL AND TRIM(email) <> '' ORDER BY username"
      : "SELECT pi_email AS email, pi_name AS name FROM labs WHERE pi_email IS NOT NULL AND TRIM(pi_email) <> '' ORDER BY name";
  const rows = db().prepare(sql).all() as { email: string; name: string | null; username?: string }[];
  const byEmail = new Map<string, Recipient>();
  for (const r of rows) {
    const email = r.email.trim();
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: r.name?.trim() || r.username?.trim() || email });
  }
  return [...byEmail.values()];
}

/** How many addressable recipients each audience currently has (for the compose UI). */
export function audienceCounts(): { students: number; pis: number } {
  return {
    students: audienceRecipients("students").length,
    pis: audienceRecipients("pis").length,
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

  // Union of the selected audiences, deduped by email (a PI who is also a student is mailed once).
  const byEmail = new Map<string, Recipient>();
  for (const a of input.audiences) {
    for (const r of audienceRecipients(a)) if (!byEmail.has(r.email)) byEmail.set(r.email, r);
  }
  const recipients = [...byEmail.values()];
  const skipped = !isSmtpConfigured();

  // {name}/{email} are substituted per recipient; the signature is fixed.
  const template = `${body}\n\n— Lab Manager`;
  let sent = 0;
  if (!skipped) {
    const results = await Promise.all(
      recipients.map((r) => {
        const vars = { name: r.name, email: r.email };
        return sendMail(r.email, renderTemplate(subject, vars), renderTemplate(template, vars));
      }),
    );
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

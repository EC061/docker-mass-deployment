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
import { extractBracketTokens, fillBracketTokens, renderTemplate } from "./template";

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
  { key: "sender", desc: "sending admin's name" },
  { key: "sender_email", desc: "sending admin's email address" },
];

/**
 * A prebuilt starting point for the compose form, editable on the Templates page (stored in the
 * `announcement_templates` table; seeded with the built-in defaults in migration 0017). {tokens}
 * render per recipient and ALL-CAPS bracketed spans become input fields on the compose form for
 * the admin to fill in before sending.
 */
export interface AnnouncementTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
}

/** All prebuilt announcement templates, in display order, for the compose picker and editor. */
export function listAnnouncementTemplates(): AnnouncementTemplate[] {
  return db()
    .prepare("SELECT id, name, subject, body FROM announcement_templates ORDER BY sort, id")
    .all() as AnnouncementTemplate[];
}

/** Add a prebuilt template; appended to the end of the display order. Returns the new id. */
export function createAnnouncementTemplate(input: { name: string; subject: string; body: string }): number {
  const name = input.name.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!name) throw new Error("template name is required");
  if (!body) throw new Error("template body is required");
  const maxSort = (db().prepare("SELECT COALESCE(MAX(sort), -1) AS m FROM announcement_templates").get() as {
    m: number;
  }).m;
  const res = db()
    .prepare("INSERT INTO announcement_templates (name, subject, body, sort) VALUES (?, ?, ?, ?)")
    .run(name, subject, body, maxSort + 1);
  return Number(res.lastInsertRowid);
}

/** Edit an existing prebuilt template in place. */
export function updateAnnouncementTemplate(
  id: number,
  input: { name: string; subject: string; body: string },
): void {
  const name = input.name.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!name) throw new Error("template name is required");
  if (!body) throw new Error("template body is required");
  const res = db()
    .prepare("UPDATE announcement_templates SET name = ?, subject = ?, body = ? WHERE id = ?")
    .run(name, subject, body, id);
  if (res.changes === 0) throw new Error("template not found");
}

/** Remove a prebuilt template. */
export function deleteAnnouncementTemplate(id: number): void {
  db().prepare("DELETE FROM announcement_templates WHERE id = ?").run(id);
}

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

/** An addressable person for the individual-recipient picker. */
export interface Person {
  email: string;
  name: string;
  kind: "user" | "pi";
}

/**
 * Everyone the compose form can address individually: all students and all PIs, deduped by email
 * (a PI who is also a student appears once, as a user), sorted by display name.
 */
export function listAnnouncementPeople(): Person[] {
  const byEmail = new Map<string, Person>();
  for (const r of audienceRecipients("students")) byEmail.set(r.email, { ...r, kind: "user" });
  for (const r of audienceRecipients("pis")) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, { ...r, kind: "pi" });
  }
  return [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
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
 * Send an announcement to the union of the selected audiences and individually picked recipients.
 * [BRACKET] placeholders are filled from `placeholders` before anything goes out (all of them are
 * required); {name}/{email} still render per recipient, and {sender}/{sender_email} render from
 * `sender` when given (left visible otherwise, like any unknown token). Returns recipient/sent
 * counts. Always records a row (even when skipped or zero recipients) so the history reflects
 * every attempt.
 */
export async function sendAnnouncement(input: {
  subject: string;
  body: string;
  audiences: Audience[];
  /** Emails picked individually; must belong to a known student or PI. */
  individuals?: string[];
  /** [BRACKET] placeholder values, keyed by token without brackets. */
  placeholders?: Record<string, string>;
  /** The sending admin, for the {sender}/{sender_email} template variables. */
  sender?: { name: string; email: string };
  actor?: string;
}): Promise<AnnouncementResult> {
  let subject = input.subject.trim();
  let body = input.body.trim();
  if (!subject) throw new Error("subject is required");
  if (!body) throw new Error("message is required");

  // Fill [BRACKET] placeholders up front so the mailed and recorded text are the final text.
  // Validate against the original token list, never a re-scan of the filled output.
  const values = input.placeholders ?? {};
  const tokens = extractBracketTokens(subject + "\n" + body);
  const missing = tokens.filter((t) => !values[t]?.trim());
  if (missing.length > 0) {
    throw new Error(`fill in the ${missing.map((t) => `[${t}]`).join(", ")} placeholder(s)`);
  }
  subject = fillBracketTokens(subject, values);
  body = fillBracketTokens(body, values);

  const individuals = [...new Set(input.individuals ?? [])];
  if (input.audiences.length === 0 && individuals.length === 0) {
    throw new Error("pick at least one audience or recipient");
  }

  // Union of the selected audiences plus picked individuals, deduped by email (a PI who is also a
  // student, or someone picked and covered by an audience, is mailed once).
  const byEmail = new Map<string, Recipient>();
  for (const a of input.audiences) {
    for (const r of audienceRecipients(a)) if (!byEmail.has(r.email)) byEmail.set(r.email, r);
  }
  if (individuals.length > 0) {
    // Resolve against known people so the form can't be used to mail arbitrary addresses.
    const known = new Map(listAnnouncementPeople().map((p) => [p.email, p]));
    for (const email of individuals) {
      const person = known.get(email);
      if (!person) throw new Error(`unknown recipient: ${email}`);
      if (!byEmail.has(email)) byEmail.set(email, { email, name: person.name });
    }
  }
  const recipients = [...byEmail.values()];
  const skipped = !isSmtpConfigured();

  // {name}/{email} are substituted per recipient, {sender}/{sender_email} once per send. sendMail
  // appends the universal signature.
  const senderVars = input.sender ? { sender: input.sender.name, sender_email: input.sender.email } : {};
  let sent = 0;
  if (!skipped) {
    const results = await Promise.all(
      recipients.map((r) => {
        const vars = { ...senderVars, name: r.name, email: r.email };
        return sendMail(r.email, renderTemplate(subject, vars), renderTemplate(body, vars));
      }),
    );
    sent = results.filter((r) => r.sent).length;
  }

  const audienceLabel = [
    ...input.audiences,
    ...(individuals.length > 0 ? [`${individuals.length} picked`] : []),
  ].join(",");
  db()
    .prepare(
      `INSERT INTO announcements (ts, actor, audiences, subject, body, recipients, sent, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      input.actor ?? null,
      audienceLabel,
      subject,
      body,
      recipients.length,
      sent,
      skipped ? 1 : 0,
    );
  audit(input.actor, "announcement.send", audienceLabel, `${sent}/${recipients.length} sent`);

  return { recipients: recipients.length, sent, skipped };
}

/** Remove one announcement from the recorded history. */
export function deleteAnnouncement(id: number, actor: string): void {
  const res = db().prepare("DELETE FROM announcements WHERE id = ?").run(id);
  if (res.changes === 0) throw new Error("announcement not found");
  audit(actor, "announcement.delete", String(id));
}

/** Wipe the recorded announcement history. Returns how many rows were removed. */
export function clearAnnouncements(actor: string): number {
  return db().transaction(() => {
    const cleared = db().prepare("DELETE FROM announcements").run().changes;
    audit(actor, "announcements.clear", undefined, `${cleared} announcement(s)`);
    return cleared;
  })();
}

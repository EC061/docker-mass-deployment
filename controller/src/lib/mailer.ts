/**
 * Email via an external SMTP server configured in the UI Settings (never bundled, never env).
 * If SMTP is not configured, send() is a no-op that returns {skipped:true} so callers (e.g. adding a
 * student) still succeed — the credential is shown in the UI regardless.
 */

import nodemailer from "nodemailer";
import {
  DEFAULT_WELCOME_BODY,
  DEFAULT_WELCOME_SUBJECT,
  getSetting,
  isSmtpConfigured,
} from "./settings";

/**
 * Substitute {placeholder} tokens in a template. Unknown tokens are left untouched so a typo in the
 * admin's template is visible rather than silently dropped. Values are coerced to strings; a
 * null/undefined value renders as an empty string.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : whole,
  );
}

export interface SendResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

function transport() {
  return nodemailer.createTransport({
    host: getSetting("smtpHost"),
    port: getSetting("smtpPort"),
    secure: getSetting("smtpSecure"),
    auth: getSetting("smtpUser")
      ? { user: getSetting("smtpUser"), pass: getSetting("smtpPass") }
      : undefined,
  });
}

export async function sendMail(to: string, subject: string, text: string): Promise<SendResult> {
  if (!isSmtpConfigured()) return { sent: false, skipped: true };
  if (!to) return { sent: false, skipped: true };
  try {
    await transport().sendMail({ from: getSetting("smtpFrom"), to, subject, text });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTestEmail(to: string): Promise<SendResult> {
  return sendMail(
    to,
    "Lab Manager test email",
    "This is a test email from the Lab Manager controller. SMTP is configured correctly.",
  );
}

export async function sendRemovalEmail(to: string, lab: string, dataDeleted: boolean): Promise<SendResult> {
  return sendMail(
    to,
    `Removed from lab ${lab}`,
    `You have been removed from the lab "${lab}". ` +
      (dataDeleted
        ? "Your scratch and cold-storage data in this lab has been deleted."
        : "Your data has been retained for now; contact an admin if you need it.") +
      "\n\n— Lab Manager",
  );
}

export interface CredentialEmail {
  to: string;
  name?: string;
  username: string;
  password: string;
  host: string;
  port: number;
  lab: string;
  node?: string;
  studentId?: string | null;
}

export async function sendGpuWarningEmail(
  to: string,
  opts: { lab: string | null; pid: number | null; graceMinutes: number },
): Promise<SendResult> {
  return sendMail(
    to,
    "Idle GPU process warning",
    `One of your processes (PID ${opts.pid ?? "?"}${opts.lab ? `, lab ${opts.lab}` : ""}) is holding GPU` +
      ` memory but is not using the GPU.\n\nIf it stays idle it will be terminated in about ` +
      `${opts.graceMinutes} minutes to free the GPU for others. If you still need it, start using ` +
      `the GPU again or contact an admin.\n\n— Lab Manager`,
  );
}

export async function sendGpuKillEmail(
  to: string,
  opts: { lab: string | null; pid: number | null },
): Promise<SendResult> {
  return sendMail(
    to,
    "Idle GPU process terminated",
    `Your idle process (PID ${opts.pid ?? "?"}${opts.lab ? `, lab ${opts.lab}` : ""}) was terminated ` +
      `because it held GPU memory without using the GPU. Please checkpoint long-running work and ` +
      `keep the GPU active, or ask an admin to whitelist your job.\n\n— Lab Manager`,
  );
}

export interface QuotaEmail {
  to: string;
  lab: string;
  pool: string;
  pct: number;
  usedHuman: string;
  quotaHuman: string;
  breakdown: { username: string; usedHuman: string }[];
}

export async function sendQuotaEmail(info: QuotaEmail): Promise<SendResult> {
  const lines = info.breakdown.length
    ? info.breakdown.map((b) => `  ${b.username.padEnd(20)} ${b.usedHuman}`).join("\n")
    : "  (no per-student usage reported yet)";
  const text = `Lab "${info.lab}" has reached ${info.pct}% of its ${info.pool} storage quota` +
    ` (${info.usedHuman} of ${info.quotaHuman}).

Per-student usage on the ${info.pool} pool:
${lines}

You may want to ask students to clean up old files, or request a larger quota.

— Lab Manager`;
  return sendMail(info.to, `Lab ${info.lab} is at ${info.pct}% of its ${info.pool} quota`, text);
}

/** Build the {placeholder} substitution map for the welcome email from a credential payload. */
export function welcomeEmailVars(info: CredentialEmail): Record<string, string | number> {
  return {
    name: info.name ?? info.username,
    username: info.username,
    password: info.password,
    host: info.host,
    port: info.port,
    lab: info.lab,
    node: info.node ?? info.host,
    student_id: info.studentId ?? "",
    email: info.to,
  };
}

/** Render the welcome email's subject + body from the admin-editable template (or its default). */
export function renderWelcomeEmail(info: CredentialEmail): { subject: string; body: string } {
  const vars = welcomeEmailVars(info);
  const subject = getSetting("welcomeEmailSubject").trim() || DEFAULT_WELCOME_SUBJECT;
  const body = getSetting("welcomeEmailBody").trim() || DEFAULT_WELCOME_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendCredentialEmail(info: CredentialEmail): Promise<SendResult> {
  const { subject, body } = renderWelcomeEmail(info);
  return sendMail(info.to, subject, body);
}

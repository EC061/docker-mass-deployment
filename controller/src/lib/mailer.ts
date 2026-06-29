/**
 * Email via an external SMTP server configured in the UI Settings (never bundled, never env).
 * If SMTP is not configured, send() is a no-op that returns {skipped:true}. Successfully provisioned
 * student credentials then remain encrypted until an admin reveals them once on the placement page.
 */

import nodemailer from "nodemailer";
import { renderTemplate } from "./template";
import {
  DEFAULT_GPU_KILL_BODY,
  DEFAULT_GPU_KILL_SUBJECT,
  DEFAULT_GPU_WARN_BODY,
  DEFAULT_GPU_WARN_SUBJECT,
  DEFAULT_WELCOME_BODY,
  DEFAULT_WELCOME_SUBJECT,
  getSetting,
  isSmtpConfigured,
} from "./settings";

// Re-exported for back-compat: callers (and tests) still import renderTemplate from the mailer.
export { renderTemplate };

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

export interface GpuEmailOpts {
  username: string;
  lab: string | null;
  pid: number | null;
  node: string;
  graceMinutes?: number;
}

/** Build the {placeholder} substitution map shared by both GPU notification templates. */
export function gpuEmailVars(opts: GpuEmailOpts): Record<string, string | number> {
  return {
    username: opts.username,
    pid: opts.pid ?? "",
    lab: opts.lab ?? "",
    node: opts.node,
    grace_minutes: opts.graceMinutes ?? "",
  };
}

/** Render the GPU idle-warning email from the admin-editable template (or its default). */
export function renderGpuWarningEmail(opts: GpuEmailOpts): { subject: string; body: string } {
  const vars = gpuEmailVars(opts);
  const subject = getSetting("gpuWarnEmailSubject").trim() || DEFAULT_GPU_WARN_SUBJECT;
  const body = getSetting("gpuWarnEmailBody").trim() || DEFAULT_GPU_WARN_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

/** Render the GPU termination email from the admin-editable template (or its default). */
export function renderGpuKillEmail(opts: GpuEmailOpts): { subject: string; body: string } {
  const vars = gpuEmailVars(opts);
  const subject = getSetting("gpuKillEmailSubject").trim() || DEFAULT_GPU_KILL_SUBJECT;
  const body = getSetting("gpuKillEmailBody").trim() || DEFAULT_GPU_KILL_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendGpuWarningEmail(to: string, opts: GpuEmailOpts): Promise<SendResult> {
  const { subject, body } = renderGpuWarningEmail(opts);
  return sendMail(to, subject, body);
}

export async function sendGpuKillEmail(to: string, opts: GpuEmailOpts): Promise<SendResult> {
  const { subject, body } = renderGpuKillEmail(opts);
  return sendMail(to, subject, body);
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

You may want to ask students to clean up unneeded data, or request a larger quota.

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

/**
 * Email via an external SMTP server configured in the UI Settings (never bundled, never env).
 * If SMTP is not configured, send() is a no-op that returns {skipped:true}. Successfully provisioned
 * student credentials then remain encrypted until an admin reveals them once on the placement page.
 */

import nodemailer from "nodemailer";
import { renderTemplate, stripLegacyEmailSignature } from "./template";
import {
  DEFAULT_GPU_KILL_BODY,
  DEFAULT_GPU_KILL_SUBJECT,
  DEFAULT_GPU_WARN_BODY,
  DEFAULT_GPU_WARN_SUBJECT,
  DEFAULT_QUOTA_BODY,
  DEFAULT_QUOTA_SUBJECT,
  DEFAULT_REMOVAL_BODY,
  DEFAULT_REMOVAL_SUBJECT,
  DEFAULT_TEST_BODY,
  DEFAULT_TEST_SUBJECT,
  DEFAULT_WELCOME_BODY,
  DEFAULT_WELCOME_SUBJECT,
  REMOVAL_DATA_DELETED,
  REMOVAL_DATA_RETAINED,
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

/** Build the text-only message with the universal signature appended. */
export function emailContent(body: string): { text: string } {
  const cleanBody = stripLegacyEmailSignature(body).trimEnd();
  const signatureText = getSetting("emailSignatureText").trim();
  return {
    text: [cleanBody, signatureText].filter(Boolean).join("\n\n"),
  };
}

export async function sendMail(to: string, subject: string, text: string): Promise<SendResult> {
  if (!isSmtpConfigured()) return { sent: false, skipped: true };
  if (!to) return { sent: false, skipped: true };
  try {
    const content = emailContent(text);
    await transport().sendMail({ from: getSetting("smtpFrom"), to, subject, ...content });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTestEmail(to: string): Promise<SendResult> {
  const subject = getSetting("testEmailSubject").trim() || DEFAULT_TEST_SUBJECT;
  const body = getSetting("testEmailBody").trim() || DEFAULT_TEST_BODY;
  return sendMail(to, subject, body);
}

/** Render the removal email from the admin-editable template (or its default). */
export function renderRemovalEmail(lab: string, dataDeleted: boolean): { subject: string; body: string } {
  const vars = {
    lab,
    data_status: dataDeleted ? REMOVAL_DATA_DELETED : REMOVAL_DATA_RETAINED,
  };
  const subject = getSetting("removalEmailSubject").trim() || DEFAULT_REMOVAL_SUBJECT;
  const body = getSetting("removalEmailBody").trim() || DEFAULT_REMOVAL_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendRemovalEmail(to: string, lab: string, dataDeleted: boolean): Promise<SendResult> {
  const { subject, body } = renderRemovalEmail(lab, dataDeleted);
  return sendMail(to, subject, body);
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

/** Build the {placeholder} substitution map for the quota-alert email. */
export function quotaEmailVars(info: Omit<QuotaEmail, "to">): Record<string, string | number> {
  const breakdown = info.breakdown.length
    ? info.breakdown.map((b) => `  ${b.username.padEnd(20)} ${b.usedHuman}`).join("\n")
    : "  (no per-student usage reported yet)";
  return {
    lab: info.lab,
    pool: info.pool,
    pct: info.pct,
    used: info.usedHuman,
    quota: info.quotaHuman,
    breakdown,
  };
}

/** Render the quota-alert email's subject + body from the admin-editable template (or its default). */
export function renderQuotaEmail(info: Omit<QuotaEmail, "to">): { subject: string; body: string } {
  const vars = quotaEmailVars(info);
  const subject = getSetting("quotaEmailSubject").trim() || DEFAULT_QUOTA_SUBJECT;
  const body = getSetting("quotaEmailBody").trim() || DEFAULT_QUOTA_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendQuotaEmail(info: QuotaEmail): Promise<SendResult> {
  const { subject, body } = renderQuotaEmail(info);
  return sendMail(info.to, subject, body);
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

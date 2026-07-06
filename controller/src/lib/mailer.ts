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
  DEFAULT_USAGE_REPORT_PI_BODY,
  DEFAULT_USAGE_REPORT_PI_SUBJECT,
  DEFAULT_USAGE_REPORT_STUDENT_BODY,
  DEFAULT_USAGE_REPORT_STUDENT_SUBJECT,
  DEFAULT_WELCOME_BODY,
  DEFAULT_WELCOME_SUBJECT,
  REMOVAL_DATA_DELETED,
  REMOVAL_DATA_RETAINED,
  type SmtpConfig,
  getSmtpConfigs,
  getSetting,
} from "./settings";

// Re-exported for back-compat: callers (and tests) still import renderTemplate from the mailer.
export { renderTemplate };

export interface SendResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

function transport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user
      ? { user: config.user, pass: config.pass }
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
  const configs = getSmtpConfigs().filter((config) => config.host && config.from);
  if (configs.length === 0) return { sent: false, skipped: true };
  if (!to) return { sent: false, skipped: true };
  const content = emailContent(text);
  const errors: string[] = [];
  for (const config of configs) {
    try {
      await transport(config).sendMail({ from: config.from, to, subject, ...content });
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(configs.length === 1 ? message : `${config.name}: ${message}`);
    }
  }
  return { sent: false, error: errors.join("; ") };
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
  hostAlias?: string;
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

export type UsageReportKind = "student" | "pi";

export interface UsageReportEmailVars {
  name: string; // recipient's greeting name (student name/username, or PI name)
  lab: string;
  node: string;
  report: string; // the plain-text usage table (see lib/usage-report.ts)
}

/** Render an admin-triggered storage-usage-report email from the admin-editable template (or its
 * default), picking the student-facing or PI-facing template by `kind`. */
export function renderUsageReportEmail(
  kind: UsageReportKind,
  vars: UsageReportEmailVars,
): { subject: string; body: string } {
  const isPi = kind === "pi";
  const subject =
    getSetting(isPi ? "usageReportPiSubject" : "usageReportStudentSubject").trim() ||
    (isPi ? DEFAULT_USAGE_REPORT_PI_SUBJECT : DEFAULT_USAGE_REPORT_STUDENT_SUBJECT);
  const body =
    getSetting(isPi ? "usageReportPiBody" : "usageReportStudentBody").trim() ||
    (isPi ? DEFAULT_USAGE_REPORT_PI_BODY : DEFAULT_USAGE_REPORT_STUDENT_BODY);
  const subs: Record<string, string> = { name: vars.name, lab: vars.lab, node: vars.node, report: vars.report };
  return { subject: renderTemplate(subject, subs), body: renderTemplate(body, subs) };
}

export async function sendUsageReportEmail(
  to: string,
  kind: UsageReportKind,
  vars: UsageReportEmailVars,
): Promise<SendResult> {
  const { subject, body } = renderUsageReportEmail(kind, vars);
  return sendMail(to, subject, body);
}

/** Build the {placeholder} substitution map for the welcome email from a credential payload. */
export function welcomeEmailVars(info: CredentialEmail): Record<string, string | number> {
  return {
    name: info.name ?? info.username,
    username: info.username,
    password: info.password,
    host: info.host,
    host_alias: info.hostAlias || info.host,
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

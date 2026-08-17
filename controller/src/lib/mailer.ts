/**
 * Email via an external SMTP server configured in the UI Settings (never bundled, never env).
 * If SMTP is not configured, send() is a no-op that returns {skipped:true}. Successfully provisioned
 * student credentials then remain encrypted until an admin reveals them once on the placement page.
 */

import nodemailer from "nodemailer";
import { emailLabName } from "./email-lab-name";
import { nameVars } from "./names";
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
  DEFAULT_STUDENT_QUOTA_BODY,
  DEFAULT_STUDENT_QUOTA_SUBJECT,
  DEFAULT_USAGE_REPORT_PI_BODY,
  DEFAULT_USAGE_REPORT_PI_SUBJECT,
  DEFAULT_USAGE_REPORT_STUDENT_BODY,
  DEFAULT_USAGE_REPORT_STUDENT_SUBJECT,
  DEFAULT_PLACEMENT_COMPLETE_BODY,
  DEFAULT_PLACEMENT_COMPLETE_SUBJECT,
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
    lab: emailLabName(lab),
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
  firstName?: string | null;
  lastName?: string | null;
  /** Standing from the roster (PhD / MS / Faculty …), for the {degree} template variable. */
  degree?: string | null;
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
    lab: opts.lab ? emailLabName(opts.lab) : "",
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
    lab: emailLabName(info.lab),
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

export interface StudentQuotaEmail {
  to: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  degree?: string | null;
  username: string;
  lab: string;
  node: string;
  pool: string;
  pct: number;
  usedHuman: string;
  quotaHuman: string;
}

export function renderStudentQuotaEmail(info: Omit<StudentQuotaEmail, "to">): { subject: string; body: string } {
  const vars = {
    ...nameVars({
      first_name: info.firstName,
      last_name: info.lastName,
      name: info.name,
      username: info.username,
    }),
    degree: info.degree ?? "",
    username: info.username,
    lab: emailLabName(info.lab),
    node: info.node,
    pool: info.pool,
    pct: info.pct,
    used: info.usedHuman,
    quota: info.quotaHuman,
  };
  const subject = getSetting("studentQuotaEmailSubject").trim() || DEFAULT_STUDENT_QUOTA_SUBJECT;
  const body = getSetting("studentQuotaEmailBody").trim() || DEFAULT_STUDENT_QUOTA_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendStudentQuotaEmail(info: StudentQuotaEmail): Promise<SendResult> {
  const { subject, body } = renderStudentQuotaEmail(info);
  return sendMail(info.to, subject, body);
}

export type UsageReportKind = "student" | "pi";

export interface UsageReportEmailVars {
  name: string; // recipient's greeting name (student name/username, or PI name)
  firstName?: string | null;
  lastName?: string | null;
  degree?: string | null;
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
  const subs: Record<string, string> = {
    ...nameVars({ first_name: vars.firstName, last_name: vars.lastName, name: vars.name }),
    degree: vars.degree ?? "",
    lab: emailLabName(vars.lab),
    node: vars.node,
    report: vars.report,
  };
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

export interface PlacementCompleteEmail {
  to: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  degree?: string | null;
  lab: string;
  node: string;
  usernames: string[];
  fastQuota: string;
  coldQuota: string;
  studentFastQuota: string;
  studentColdQuota: string;
}

export function renderPlacementCompleteEmail(
  info: Omit<PlacementCompleteEmail, "to">,
): { subject: string; body: string } {
  const vars = {
    ...nameVars({ first_name: info.firstName, last_name: info.lastName, name: info.name }),
    degree: info.degree ?? "",
    lab: emailLabName(info.lab),
    node: info.node,
    usernames: info.usernames.map((username) => `  ${username}`).join("\n"),
    fast_quota: info.fastQuota,
    cold_quota: info.coldQuota,
    student_fast_quota: info.studentFastQuota,
    student_cold_quota: info.studentColdQuota,
  };
  const subject = getSetting("placementCompleteEmailSubject").trim() || DEFAULT_PLACEMENT_COMPLETE_SUBJECT;
  const body = getSetting("placementCompleteEmailBody").trim() || DEFAULT_PLACEMENT_COMPLETE_BODY;
  return { subject: renderTemplate(subject, vars), body: renderTemplate(body, vars) };
}

export async function sendPlacementCompleteEmail(info: PlacementCompleteEmail): Promise<SendResult> {
  const { subject, body } = renderPlacementCompleteEmail(info);
  return sendMail(info.to, subject, body);
}

/** Build the {placeholder} substitution map for the welcome email from a credential payload. */
export function welcomeEmailVars(info: CredentialEmail): Record<string, string | number> {
  return {
    ...nameVars({
      first_name: info.firstName,
      last_name: info.lastName,
      name: info.name,
      username: info.username,
    }),
    degree: info.degree ?? "",
    username: info.username,
    password: info.password,
    host: info.host,
    host_alias: info.hostAlias || info.host,
    port: info.port,
    lab: emailLabName(info.lab),
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

/**
 * Email via an external SMTP server configured in the UI Settings (never bundled, never env).
 * If SMTP is not configured, send() is a no-op that returns {skipped:true} so callers (e.g. adding a
 * student) still succeed — the credential is shown in the UI regardless.
 */

import nodemailer from "nodemailer";
import { getSetting, isSmtpConfigured } from "./settings";

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

export interface CredentialEmail {
  to: string;
  name?: string;
  username: string;
  password: string;
  host: string;
  port: number;
  lab: string;
}

export async function sendGpuWarningEmail(
  to: string,
  opts: { lab: string | null; pid: number; graceMinutes: number },
): Promise<SendResult> {
  return sendMail(
    to,
    "Idle GPU process warning",
    `One of your processes (PID ${opts.pid}${opts.lab ? `, lab ${opts.lab}` : ""}) is holding GPU` +
      ` memory but is not using the GPU.\n\nIf it stays idle it will be terminated in about ` +
      `${opts.graceMinutes} minutes to free the GPU for others. If you still need it, start using ` +
      `the GPU again or contact an admin.\n\n— Lab Manager`,
  );
}

export async function sendGpuKillEmail(
  to: string,
  opts: { lab: string | null; pid: number },
): Promise<SendResult> {
  return sendMail(
    to,
    "Idle GPU process terminated",
    `Your idle process (PID ${opts.pid}${opts.lab ? `, lab ${opts.lab}` : ""}) was terminated ` +
      `because it held GPU memory without using the GPU. Please checkpoint long-running work and ` +
      `keep the GPU active, or ask an admin to whitelist your job.\n\n— Lab Manager`,
  );
}

export async function sendCredentialEmail(info: CredentialEmail): Promise<SendResult> {
  const text = `Hello ${info.name ?? info.username},

You have been added to the lab "${info.lab}". Connect over SSH:

    ssh ${info.username}@${info.host} -p ${info.port}

  Username: ${info.username}
  Password: ${info.password}

Your home directory contains:
  ~/scratch        fast storage for working data
  ~/cold-storage   slower storage for data you want to keep but rarely touch

Please change your password after first login (run: passwd).

— Lab Manager`;
  return sendMail(info.to, `Your access to lab ${info.lab}`, text);
}

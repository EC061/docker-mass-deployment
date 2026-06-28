/**
 * Admin alerting. A log at/above the configured level, a node going offline, or a failed task emails
 * every registered admin — but rate-limited per key so an error storm sends one alert, not thousands.
 *
 * Suppressed occurrences within the dedup window are counted and reported on the next alert for that
 * key ("(N similar suppressed since the last alert)"), so nothing is silently lost.
 */

import { db } from "./db";
import { sendMail } from "./mailer";
import { getSetting } from "./settings";

const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

interface KeyState {
  lastSent: number;
  suppressed: number;
}
const state = new Map<string, KeyState>();

function adminEmails(): string[] {
  return (db().prepare("SELECT email FROM admins").all() as { email: string }[])
    .map((r) => r.email)
    .filter(Boolean);
}

/** Send an alert to all admins, rate-limited by `key`. Fire-and-forget friendly. */
export async function alertAdmins(key: string, subject: string, body: string): Promise<void> {
  if (!getSetting("alertsEnabled")) return;
  const now = Date.now();
  const windowMs = getSetting("alertDedupMinutes") * 60 * 1000;
  const st = state.get(key);
  if (st && now - st.lastSent < windowMs) {
    st.suppressed++;
    return;
  }
  const suppressed = st?.suppressed ?? 0;
  state.set(key, { lastSent: now, suppressed: 0 });

  const emails = adminEmails();
  if (emails.length === 0) return;
  const note = suppressed > 0 ? `\n\n(${suppressed} similar suppressed since the last alert)` : "";
  await Promise.all(emails.map((to) => sendMail(to, subject, body + note)));
}

/** Called for every ingested log line; alerts when level >= the configured threshold. */
export function maybeAlertOnLog(row: {
  node?: string | null;
  level: string;
  source?: string | null;
  msg: string;
  detail?: string | null;
}): void {
  const threshold = LEVELS[getSetting("alertLevel")] ?? LEVELS.ERROR;
  if ((LEVELS[row.level] ?? 0) < threshold) return;
  const key = `log:${row.node ?? "-"}:${row.source ?? "-"}:${row.level}`;
  const subject = `[${row.level}] ${row.node ?? "controller"} ${row.source ?? ""}`.trim();
  const body = `${row.msg}${row.detail ? `\n\n${row.detail}` : ""}`;
  void alertAdmins(key, subject, body);
}

export function alertNodeOffline(node: string, label?: string): void {
  // `label` is the node's UI alias when set, so the alert reads "GPU Box A (gpu-01)".
  const display = label && label !== node ? `${label} (${node})` : node;
  void alertAdmins(
    `node-offline:${node}`,
    `Node offline: ${display}`,
    `Node ${display} has been disconnected from the controller for longer than the grace window.`,
  );
}

export function alertTaskFailed(node: string, action: string, error: string): void {
  void alertAdmins(
    `task-failed:${node}:${action}`,
    `Task failed on ${node}: ${action}`,
    `A ${action} task failed on node ${node}.\n\n${error}`,
  );
}

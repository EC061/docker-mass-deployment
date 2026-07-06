"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { putFlash } from "@/lib/flash";
import { sendUsageReportEmail } from "@/lib/mailer";
import { createNodeGroup, deleteNodeGroup, renameNodeGroup, setNodeGroupMembers } from "@/lib/nodegroups";
import { listAllPlacements } from "@/lib/placements";
import { enqueueTask } from "@/lib/queue";
import { buildUsageReport } from "@/lib/usage-report";

/** Usernames enrolled in a lab, for the usage.scan payload. */
function labUsernames(labId: number): string[] {
  return (db()
    .prepare(
      `SELECT students.username AS username FROM lab_members
       JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
    )
    .all(labId) as { username: string }[]).map((r) => r.username);
}

/**
 * Trigger an on-demand storage scan for one placement (a lab on a node). The agent runs the
 * per-student (du) breakdown on the same single-flight path as its nightly scan AND recomputes the
 * placement-level totals (image + fast/cold), so a single "Scan now" refreshes the whole Stats page;
 * the fresh numbers reach us on the agent's next heartbeat.
 */
export async function usageScanAction(formData: FormData) {
  const who = (await requireAdmin()).email;
  const placementId = Number(formData.get("placementId"));
  const placement = db()
    .prepare(
      `SELECT labs.name AS lab, nodes.name AS node, p.lab_id AS lab_id
       FROM lab_placements p JOIN labs ON labs.id = p.lab_id JOIN nodes ON nodes.id = p.node_id
       WHERE p.id = ?`,
    )
    .get(placementId) as { lab: string; node: string; lab_id: number } | undefined;
  if (!placement) return;
  const users = labUsernames(placement.lab_id);
  enqueueTask(placement.node, "usage.scan", { lab: placement.lab, users }, who);
  revalidatePath("/stats");
}

/**
 * Global refresh for the whole Stats page. Per-node pool usage is reported every heartbeat, so
 * re-rendering already shows the newest pool numbers; on top of that this kicks a fresh usage.scan on
 * every placement whose node is online (the agent runs the per-student du breakdown AND recomputes
 * the lab-level totals on that one path), so a single click refreshes everything the page shows. With
 * no online placements it simply re-pulls the latest telemetry.
 */
export async function refreshAllAction() {
  const who = (await requireAdmin()).email;
  for (const p of listAllPlacements()) {
    if (p.online !== 1) continue;
    enqueueTask(p.node_name, "usage.scan", { lab: p.lab_name, users: labUsernames(p.lab_id) }, who);
  }
  revalidatePath("/stats");
}

/**
 * Result of {@link emailUsageReportAction}, consumed by the (separate) Stats-page UI task.
 * Exactly one `status` per call:
 *   - "sent"              — the email was handed to SMTP; `to` is the address it went to.
 *   - "skipped"           — SMTP is not configured, so nothing was sent; `to` is the intended address.
 *   - "missing_email"     — the chosen recipient has no email address on file.
 *   - "unknown_recipient" — the studentId isn't on the lab's roster (or the recipient value was bad).
 *   - "unknown_placement" — the placement doesn't exist, so no report could be built.
 *   - "send_failed"       — SMTP was configured but every server failed; `error` carries the reason.
 */
export type EmailUsageReportResult =
  | { status: "sent"; to: string }
  | { status: "skipped"; to: string }
  | { status: "missing_email" }
  | { status: "unknown_recipient" }
  | { status: "unknown_placement" }
  | { status: "send_failed"; error: string };

/**
 * Email a storage-usage report for one placement, asking the recipient to clean up files. The
 * recipient is either the lab's PI (`recipient="pi"`) or one roster student (`recipient=<studentId>`);
 * a student gets their own row highlighted "(you)" and is greeted by name (falling back to username),
 * while the PI is greeted by pi_name (falling back to "Professor").
 */
export async function emailUsageReportAction(formData: FormData): Promise<EmailUsageReportResult> {
  const who = (await requireAdmin()).email;
  const placementId = Number(formData.get("placementId"));
  const recipient = String(formData.get("recipient") ?? "");
  const toPi = recipient === "pi";

  let studentId: number | undefined;
  if (!toPi) {
    studentId = Number(recipient);
    if (!Number.isInteger(studentId) || studentId <= 0) return { status: "unknown_recipient" };
  }

  const report = buildUsageReport(placementId, { highlightStudentId: studentId });
  if (!report) return { status: "unknown_placement" };

  let to: string | null;
  let name: string;
  if (toPi) {
    to = report.piEmail;
    name = report.piName?.trim() || "Professor";
  } else {
    const student = report.students.find((s) => s.studentId === studentId);
    if (!student) return { status: "unknown_recipient" };
    to = student.email;
    name = student.name?.trim() || student.username;
  }
  if (!to || !to.trim()) return { status: "missing_email" };

  const result = await sendUsageReportEmail(to, toPi ? "pi" : "student", {
    name,
    lab: report.labName,
    node: report.nodeName,
    report: report.text,
  });
  revalidatePath("/stats");
  if (result.sent) {
    audit(who, "usage_report.email", `${report.labName}@${report.nodeName}`, `to ${to} (${toPi ? "PI" : "student"})`);
    return { status: "sent", to };
  }
  if (result.skipped) return { status: "skipped", to };
  return { status: "send_failed", error: result.error ?? "Unknown send error" };
}

/** Run a node-group mutation, surfacing any error as a flash on the Stats page. */
async function withGroupFlash(fn: (who: string) => void): Promise<void> {
  const who = (await requireAdmin()).email;
  try {
    fn(who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not update node groups");
    redirect(`/stats?error=${fid}`);
  }
  revalidatePath("/stats");
}

export async function createNodeGroupAction(formData: FormData) {
  const name = String(formData.get("name") ?? "");
  await withGroupFlash((who) => createNodeGroup(name, who));
}

export async function renameNodeGroupAction(formData: FormData) {
  const groupId = Number(formData.get("groupId"));
  const name = String(formData.get("name") ?? "");
  await withGroupFlash((who) => renameNodeGroup(groupId, name, who));
}

export async function deleteNodeGroupAction(formData: FormData) {
  const groupId = Number(formData.get("groupId"));
  await withGroupFlash((who) => deleteNodeGroup(groupId, who));
  const fid = putFlash("Node group deleted. The nodes and their data are untouched.");
  redirect(`/stats?saved=${fid}`);
}

export async function setNodeGroupMembersAction(formData: FormData) {
  const groupId = Number(formData.get("groupId"));
  const nodeIds = formData.getAll("nodeId").map((v) => Number(v)).filter((n) => Number.isFinite(n));
  await withGroupFlash((who) => setNodeGroupMembers(groupId, nodeIds, who));
}

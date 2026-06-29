"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { putFlash } from "@/lib/flash";
import { createNodeGroup, deleteNodeGroup, renameNodeGroup, setNodeGroupMembers } from "@/lib/nodegroups";
import { enqueueTask } from "@/lib/queue";

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
  const users = (db()
    .prepare(
      `SELECT students.username AS username FROM lab_members
       JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
    )
    .all(placement.lab_id) as { username: string }[]).map((r) => r.username);
  enqueueTask(placement.node, "usage.scan", { lab: placement.lab, users }, who);
  revalidatePath("/stats");
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
}

export async function setNodeGroupMembersAction(formData: FormData) {
  const groupId = Number(formData.get("groupId"));
  const nodeIds = formData.getAll("nodeId").map((v) => Number(v)).filter((n) => Number.isFinite(n));
  await withGroupFlash((who) => setNodeGroupMembers(groupId, nodeIds, who));
}

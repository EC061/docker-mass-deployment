"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueTask } from "@/lib/queue";

/**
 * Trigger an on-demand storage scan for one lab. The agent runs the per-student (du) breakdown on
 * the same single-flight path as its nightly scan AND recomputes the lab-level totals (image +
 * fast/cold), so a single "Scan now" refreshes the whole Stats page; the fresh numbers reach us on
 * the agent's next heartbeat.
 */
export async function usageScanAction(formData: FormData) {
  const who = (await requireAdmin()).email;
  const labId = Number(formData.get("labId"));
  const lab = db()
    .prepare(
      "SELECT labs.name AS name, nodes.name AS node FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE labs.id = ?",
    )
    .get(labId) as { name: string; node: string } | undefined;
  if (!lab) return;
  const users = (db()
    .prepare(
      `SELECT students.username AS username FROM lab_members
       JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
    )
    .all(labId) as { username: string }[]).map((r) => r.username);
  enqueueTask(lab.node, "usage.scan", { lab: lab.name, users }, who);
  revalidatePath("/stats");
}

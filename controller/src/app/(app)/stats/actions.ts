"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
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

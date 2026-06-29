"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueTask } from "@/lib/queue";

/**
 * Trigger an on-demand per-student storage (du) scan for one lab. The agent runs it on the same
 * single-flight path as its nightly scan and reports the fresh per-student home/fast/cold numbers
 * on its next heartbeat. (Container-level usage is measured live every heartbeat, independent of this.)
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

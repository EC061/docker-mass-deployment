"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { createLab, destroyLab, updateQuota } from "@/lib/labs";
import { enqueueTask } from "@/lib/queue";
import { getSettings, nextSshPort, TIB } from "@/lib/settings";

async function actor(): Promise<string | undefined> {
  return (await currentAdmin())?.email;
}

const tbToBytes = (tb: number) => Math.round(tb * TIB);

export async function createLabAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const nodeId = Number(formData.get("nodeId"));
  const piEmail = String(formData.get("piEmail") ?? "").trim() || undefined;
  const image = String(formData.get("image") ?? "").trim() || "custom-ssh";
  const fastTb = Number(formData.get("fastTb"));
  const slowTb = Number(formData.get("slowTb"));
  if (!name || !nodeId) throw new Error("Name and node are required");

  createLab({
    name,
    nodeId,
    piEmail,
    image,
    fastQuotaBytes: tbToBytes(fastTb),
    slowQuotaBytes: tbToBytes(slowTb),
    sshPort: nextSshPort(),
    actor: await actor(),
  });
  revalidatePath("/labs");
}

export async function setQuotaAction(formData: FormData) {
  const labId = Number(formData.get("labId"));
  const fastTb = formData.get("fastTb");
  const slowTb = formData.get("slowTb");
  updateQuota(
    labId,
    fastTb !== null && fastTb !== "" ? tbToBytes(Number(fastTb)) : undefined,
    slowTb !== null && slowTb !== "" ? tbToBytes(Number(slowTb)) : undefined,
    await actor(),
  );
  revalidatePath("/labs");
  revalidatePath(`/labs/${labId}`);
}

export async function destroyLabAction(formData: FormData) {
  const labId = Number(formData.get("labId"));
  destroyLab(labId, await actor());
  revalidatePath("/labs");
}

export async function rescanAction(formData: FormData) {
  const labId = Number(formData.get("labId"));
  const lab = db().prepare("SELECT labs.name AS name, nodes.name AS node FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE labs.id = ?").get(labId) as
    | { name: string; node: string }
    | undefined;
  if (!lab) return;
  const users = (db()
    .prepare(
      `SELECT students.username AS username FROM lab_members
       JOIN students ON students.id = lab_members.student_id WHERE lab_members.lab_id = ?`,
    )
    .all(labId) as { username: string }[]).map((r) => r.username);
  enqueueTask(
    lab.node,
    "oldfiles.scan",
    { lab: lab.name, users, threshold_days: getSettings().oldFileThresholdDays },
    await actor(),
  );
  revalidatePath(`/labs/${labId}`);
}

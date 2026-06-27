"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { putFlash } from "@/lib/flash";
import { createLab, destroyLab, getLab, updateLabSettings, updateQuota } from "@/lib/labs";
import { enqueueTask } from "@/lib/queue";
import { getSettings, nextSshPort, TIB } from "@/lib/settings";
import { addStudentToLab, copyMembers, removeStudentFromLab } from "@/lib/students";

// Enforcing auth gate: throws/redirects when the caller is not a live admin, and returns the
// verified email used as the audit actor. Call as the first line of every action.
async function actor(): Promise<string> {
  return (await requireAdmin()).email;
}

const tbToBytes = (tb: number) => Math.round(tb * TIB);

export async function createLabAction(formData: FormData) {
  const who = await actor();
  const name = String(formData.get("name") ?? "").trim();
  const nodeId = Number(formData.get("nodeId"));
  const piEmail = String(formData.get("piEmail") ?? "").trim() || undefined;
  if (!name || !nodeId) throw new Error("Name and node are required");

  // Optionally seed configuration (image, quotas, container options) from an existing lab. The
  // explicit form fields still win, so the source lab acts as a starting template, not a lock.
  const copyFromLabId = Number(formData.get("copyFromLabId")) || 0;
  const source = copyFromLabId ? getLab(copyFromLabId) : undefined;

  const image = String(formData.get("image") ?? "").trim() || source?.image || "custom-ssh";
  const fastTb = Number(formData.get("fastTb"));
  const slowTb = Number(formData.get("slowTb"));

  const containerOptions = {
    cpus: String(formData.get("cpus") ?? "4"),
    memory: String(formData.get("memory") ?? "8g"),
    shm_size: String(formData.get("shmSize") ?? "1g"),
    image_quota: String(formData.get("imageQuota") ?? "300g"),
    restart: String(formData.get("restart") ?? "unless-stopped"),
  };

  const lab = createLab({
    name,
    nodeId,
    piEmail,
    image,
    fastQuotaBytes: tbToBytes(fastTb),
    slowQuotaBytes: tbToBytes(slowTb),
    sshPort: nextSshPort(),
    containerOptions,
    actor: who,
  });

  // Optionally enroll the source lab's students into the new lab (fresh accounts + emailed creds).
  if (source && formData.get("copyStudents") === "on") {
    const res = await copyMembers(source.id, lab.id, who);
    const msg = `Imported ${res.added} student${res.added === 1 ? "" : "s"} from ${source.name}` +
      (res.emailed ? `; ${res.emailed} emailed credentials` : "") +
      (res.skipped ? `; ${res.skipped} already members` : "");
    const fid = putFlash(msg);
    revalidatePath("/labs");
    redirect(`/labs?imported=${fid}`);
  }

  revalidatePath("/labs");
}

export async function updateLabSettingsAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const piEmail = String(formData.get("piEmail") ?? "").trim();
  const image = String(formData.get("image") ?? "").trim() || "custom-ssh";
  const containerOptions = {
    cpus: String(formData.get("cpus") ?? "4"),
    memory: String(formData.get("memory") ?? "8g"),
    shm_size: String(formData.get("shmSize") ?? "1g"),
    image_quota: String(formData.get("imageQuota") ?? "300g"),
    restart: String(formData.get("restart") ?? "unless-stopped"),
  };
  const recreated = updateLabSettings(labId, { piEmail, image, containerOptions }, who);
  revalidatePath(`/labs/${labId}`);
  revalidatePath("/labs");
  const fid = putFlash(
    recreated
      ? "Settings saved — container is being recreated (data preserved)."
      : "Settings saved.",
  );
  redirect(`/labs/${labId}?saved=${fid}`);
}

export async function setQuotaAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const fastTb = formData.get("fastTb");
  const slowTb = formData.get("slowTb");
  updateQuota(
    labId,
    fastTb !== null && fastTb !== "" ? tbToBytes(Number(fastTb)) : undefined,
    slowTb !== null && slowTb !== "" ? tbToBytes(Number(slowTb)) : undefined,
    who,
  );
  revalidatePath("/labs");
  revalidatePath(`/labs/${labId}`);
}

export async function destroyLabAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  destroyLab(labId, who);
  revalidatePath("/labs");
}

export async function rescanAction(formData: FormData) {
  const who = await actor();
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
    who,
  );
  revalidatePath(`/labs/${labId}`);
}

export async function recreateContainerAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const lab = db()
    .prepare(
      "SELECT labs.name AS name, labs.image AS image, labs.ssh_port AS ssh_port, labs.container_options AS opts, nodes.name AS node FROM labs JOIN nodes ON nodes.id = labs.node_id WHERE labs.id = ?",
    )
    .get(labId) as { name: string; image: string; ssh_port: number | null; opts: string | null; node: string } | undefined;
  if (!lab) return;
  enqueueTask(
    lab.node,
    "container.recreate",
    {
      lab: lab.name,
      image: lab.image,
      ssh_port: lab.ssh_port,
      container_options: lab.opts ? JSON.parse(lab.opts) : {},
    },
    who,
  );
  revalidatePath(`/labs/${labId}`);
}

export async function addMemberAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const email = String(formData.get("email") ?? "").trim() || undefined;
  const name = String(formData.get("name") ?? "").trim() || undefined;
  if (!username) throw new Error("Username required");
  const result = await addStudentToLab(labId, { username, email, name }, who);
  revalidatePath(`/labs/${labId}`);
  // Show the generated password once via a one-time server-side flash — never put the cleartext
  // credential in the redirect URL / history / access logs (M-07).
  const pwid = putFlash(result.password);
  const emailed = result.emailed ? "&emailed=1" : "";
  redirect(`/labs/${labId}?newuser=${encodeURIComponent(username)}&pwid=${pwid}${emailed}`);
}

export async function removeMemberAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const studentId = Number(formData.get("studentId"));
  const deleteData = formData.get("deleteData") === "on";
  removeStudentFromLab(labId, studentId, deleteData, who);
  revalidatePath(`/labs/${labId}`);
}

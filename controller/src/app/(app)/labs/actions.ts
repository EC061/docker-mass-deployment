"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { putFlash } from "@/lib/flash";
import { applyLabImport, type ImportPlan, type ImportResult, planLabImport } from "@/lib/labimport";
import { createLab, destroyLab, getLab, updateLabMeta } from "@/lib/labs";
import {
  type ContainerOptions,
  createPlacement,
  destroyPlacement,
  getPlacement,
  nextSshPortForNode,
  recreatePlacement,
  retryPlacement,
  updatePlacementQuota,
} from "@/lib/placements";
import { TIB } from "@/lib/settings";
import { addStudentToLab, copyMembers, removeStudentFromLab } from "@/lib/students";

// Enforcing auth gate: throws/redirects when the caller is not a live admin, and returns the
// verified email used as the audit actor. Call as the first line of every action.
async function actor(): Promise<string> {
  return (await requireAdmin()).email;
}

function tbToBytes(value: FormDataEntryValue | null, label: string): number {
  const tb = Number(value);
  if (!Number.isFinite(tb) || tb <= 0 || tb > 100_000) {
    throw new Error(`${label} quota must be a positive number no greater than 100,000 TB`);
  }
  return Math.round(tb * TIB);
}

function containerOptionsFromForm(formData: FormData): ContainerOptions {
  return {
    cpus: String(formData.get("cpus") ?? "4"),
    memory: String(formData.get("memory") ?? "8g"),
    shm_size: String(formData.get("shmSize") ?? "1g"),
    image_quota: String(formData.get("imageQuota") ?? "300g"),
    restart: String(formData.get("restart") ?? "unless-stopped"),
  };
}

/** Create a node-independent logical lab (name + PI). Node access is granted separately. */
export async function createLabAction(formData: FormData) {
  const who = await actor();
  const name = String(formData.get("name") ?? "").trim();
  const piName = String(formData.get("piName") ?? "").trim() || undefined;
  const piEmail = String(formData.get("piEmail") ?? "").trim() || undefined;
  if (!name) throw new Error("Lab name is required");

  const lab = createLab({ name, piName, piEmail, actor: who });

  // Optionally seed the roster from an existing lab (membership only; each placement later created
  // for this lab provisions these students).
  const copyFromLabId = Number(formData.get("copyFromLabId")) || 0;
  if (copyFromLabId && formData.get("copyStudents") === "on") {
    const res = await copyMembers(copyFromLabId, lab.id, who);
    const fid = putFlash(
      `Created ${lab.name}. Copied ${res.added} student${res.added === 1 ? "" : "s"} to the roster` +
        (res.skipped ? `; ${res.skipped} already members` : "") +
        ". Grant the lab access to a node to provision them.",
    );
    revalidatePath("/labs");
    redirect(`/labs/${lab.id}?saved=${fid}`);
  }

  revalidatePath("/labs");
  redirect(`/labs/${lab.id}`);
}

export async function updateLabMetaAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const piName = String(formData.get("piName") ?? "").trim();
  const piEmail = String(formData.get("piEmail") ?? "").trim();
  updateLabMeta(labId, { piName, piEmail }, who);
  revalidatePath(`/labs/${labId}`);
  const fid = putFlash("Lab metadata saved.");
  redirect(`/labs/${labId}?saved=${fid}`);
}

export async function destroyLabAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const res = destroyLab(labId, who);
  revalidatePath("/labs");
  revalidatePath("/students");
  if (res.deleted) redirect("/labs");
  // Placements are tearing down; the lab is kept until each node confirms. Stay on the detail page.
  const fid = putFlash(
    `Tearing down ${res.teardownStarted} placement(s). The lab is removed once every node confirms; delete again then.`,
  );
  redirect(`/labs/${labId}?saved=${fid}`);
}

/** Grant a lab access to a node: create a placement and provision the current roster. */
export async function grantNodeAccessAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const nodeId = Number(formData.get("nodeId"));
  if (!labId || !nodeId) throw new Error("Lab and node are required");
  const image = String(formData.get("image") ?? "").trim() || "custom-ssh";
  const coldTb = formData.get("coldTb");
  try {
    await createPlacement({
      labId,
      nodeId,
      fastQuotaBytes: tbToBytes(formData.get("fastTb"), "Fast"),
      coldQuotaBytes: coldTb === null || coldTb === "" ? null : tbToBytes(coldTb, "Cold"),
      sshPort: nextSshPortForNode(nodeId),
      image,
      containerOptions: containerOptionsFromForm(formData),
      actor: who,
    });
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not grant node access");
    redirect(`/labs/${labId}?error=${fid}`);
  }
  revalidatePath(`/labs/${labId}`);
  const fid = putFlash("Node access granted — provisioning the lab and roster on that node.");
  redirect(`/labs/${labId}?saved=${fid}`);
}

export async function setPlacementQuotaAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const placement = getPlacement(placementId);
  if (!placement) return;
  const fastTb = formData.get("fastTb");
  const coldTb = formData.get("coldTb");
  try {
    updatePlacementQuota(
      placementId,
      {
        fastQuotaBytes: fastTb !== null && fastTb !== "" ? tbToBytes(fastTb, "Fast") : undefined,
        // SMB clients have no local cold quota; their owner placement is linked from the page.
        coldQuotaBytes:
          placement.cold_quota_bytes !== null && coldTb !== null && coldTb !== ""
            ? tbToBytes(coldTb, "Cold")
            : undefined,
      },
      who,
    );
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not update quota");
    redirect(`/labs/${placement.lab_id}/placements/${placement.id}?error=${fid}`);
  }
  revalidatePath(`/labs/${placement.lab_id}`);
  revalidatePath(`/labs/${placement.lab_id}/placements/${placement.id}`);
  const fid = putFlash("Quota update queued. Desired and agent-reported values are shown separately until it applies.");
  redirect(`/labs/${placement.lab_id}/placements/${placement.id}?saved=${fid}`);
}

export async function recreatePlacementAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const placement = getPlacement(placementId);
  if (!placement) return;
  // Recreate with the current (unchanged) settings.
  recreatePlacement(placementId, {}, who);
  revalidatePath(`/labs/${placement.lab_id}`);
}

/**
 * Dedicated recreation: apply proposed image + resource settings and recreate the container. The
 * agent validates/pulls the image, brings up a candidate, verifies readiness, and only then promotes
 * it (rolling back to the previous container on any failure) — all data is preserved.
 */
export async function recreatePlacementSettingsAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const placement = getPlacement(placementId);
  if (!placement) redirect("/labs");
  const image = String(formData.get("image") ?? "").trim() || "custom-ssh";
  const containerOptions = containerOptionsFromForm(formData);
  try {
    recreatePlacement(placementId, { image, containerOptions }, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "recreate failed");
    redirect(`/labs/${placement!.lab_id}/placements/${placementId}/recreate?error=${fid}`);
  }
  revalidatePath(`/labs/${placement!.lab_id}`);
  revalidatePath(`/labs/${placement!.lab_id}/placements/${placementId}`);
  const fid = putFlash("Container recreate queued — the node validates the image, brings up a candidate, verifies readiness, then promotes it (data preserved).");
  redirect(`/labs/${placement!.lab_id}/placements/${placementId}?saved=${fid}`);
}

export async function retryPlacementAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const placement = getPlacement(placementId);
  if (!placement) redirect("/labs");
  try {
    retryPlacement(placementId, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not retry placement");
    redirect(`/labs/${placement!.lab_id}/placements/${placementId}?error=${fid}`);
  }
  revalidatePath(`/labs/${placement!.lab_id}`);
  revalidatePath(`/labs/${placement!.lab_id}/placements/${placementId}`);
  const fid = putFlash("Placement retry queued with its existing storage and container settings.");
  redirect(`/labs/${placement!.lab_id}/placements/${placementId}?saved=${fid}`);
}

export async function removePlacementAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const placement = getPlacement(placementId);
  if (!placement) return;
  try {
    destroyPlacement(placementId, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not remove placement");
    redirect(`/labs/${placement!.lab_id}/placements/${placementId}?error=${fid}`);
  }
  revalidatePath(`/labs/${placement.lab_id}`);
  revalidatePath(`/labs/${placement.lab_id}/placements/${placement.id}`);
  const fid = putFlash("Removal queued. The placement remains visible until the node confirms destruction.");
  redirect(`/labs/${placement.lab_id}/placements/${placement.id}?saved=${fid}`);
}

export async function addMemberAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const email = String(formData.get("email") ?? "").trim() || undefined;
  const name = String(formData.get("name") ?? "").trim() || undefined;
  const studentId = String(formData.get("studentId") ?? "").trim() || undefined;
  if (!username) throw new Error("Username required");
  const result = await addStudentToLab(labId, { username, email, name, studentId }, who);
  revalidatePath(`/labs/${labId}`);

  const n = result.provisioned.length;
  if (n === 1) {
    // Show the single generated password once via a one-time server-side flash — never in the URL (M-07).
    const pwid = putFlash(result.provisioned[0].password);
    const emailed = result.provisioned[0].emailed ? "&emailed=1" : "";
    redirect(`/labs/${labId}?newuser=${encodeURIComponent(username)}&pwid=${pwid}${emailed}`);
  }
  const msg =
    n === 0
      ? `Added ${username} to the roster. They are provisioned automatically when the lab is granted node access.`
      : `Added ${username} and provisioned on ${n} node(s); credentials emailed where an address exists.`;
  const fid = putFlash(msg);
  redirect(`/labs/${labId}?saved=${fid}`);
}

/** Preview a lab+roster CSV import: validate the whole file against the DB without writing anything. */
export async function previewLabImportAction(text: string): Promise<ImportPlan> {
  await requireAdmin();
  return planLabImport(String(text ?? ""));
}

/** Apply a previewed lab+roster CSV import in one transaction. */
export async function applyLabImportAction(text: string): Promise<{ result?: ImportResult; error?: string }> {
  const who = await actor();
  try {
    const result = await applyLabImport(String(text ?? ""), who);
    revalidatePath("/labs");
    revalidatePath("/students");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "import failed" };
  }
}

export async function removeMemberAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const studentId = Number(formData.get("studentId"));
  const deleteData = formData.get("deleteData") === "on";
  removeStudentFromLab(labId, studentId, deleteData, who);
  revalidatePath(`/labs/${labId}`);
  revalidatePath("/students");
}

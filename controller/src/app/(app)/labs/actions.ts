"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { putFlash } from "@/lib/flash";
import { applyRosterImport, type RosterImportPlan, type RosterImportResult, planRosterImport } from "@/lib/labimport";
import { createLab, destroyLab, getLab, updateLabMeta } from "@/lib/labs";
import {
  type ContainerOptions,
  consumePlacementCredential,
  createPlacement,
  destroyPlacement,
  forceDeletePlacement,
  getPlacement,
  nextSshPortForNode,
  recreatePlacement,
  retryPlacement,
  updatePlacementQuota,
} from "@/lib/placements";
import { QUOTA_UNIT_BYTES, type QuotaUnit } from "@/lib/format";
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

const MAX_QUOTA_BYTES = 100_000 * TIB;

/** Amount+unit quota input (used by the live-quota form, which lets admins pick MB/GB/TB and any
 * decimal amount instead of being pinned to whole-TB steps). */
function amountToBytes(amount: FormDataEntryValue | null, unit: FormDataEntryValue | null, label: string): number {
  const n = Number(amount);
  const perUnit = QUOTA_UNIT_BYTES[String(unit) as QuotaUnit];
  if (!perUnit) throw new Error(`${label} quota unit must be MB, GB, or TB`);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} quota must be a positive number`);
  }
  const bytes = Math.round(n * perUnit);
  if (bytes > MAX_QUOTA_BYTES) {
    throw new Error(`${label} quota must be no greater than 100,000 TB`);
  }
  return bytes;
}

function containerOptionsFromForm(formData: FormData): ContainerOptions {
  return {
    cpus: String(formData.get("cpus") ?? "4"),
    memory: String(formData.get("memory") ?? "8g"),
    shm_size: String(formData.get("shmSize") ?? "1g"),
    rootfs_quota: String(formData.get("rootfsQuota") ?? "300g"),
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
  // "force" purges placements stuck on offline nodes instead of waiting for a confirmation that
  // can never arrive; placements on online nodes still get a normal teardown.
  const force = formData.get("force") === "1";
  let res;
  try {
    res = destroyLab(labId, who, force);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not delete lab");
    redirect(`/labs/${labId}?error=${fid}`);
  }
  revalidatePath("/labs");
  revalidatePath("/students");
  if (res!.deleted) redirect("/labs");
  // Placements are tearing down; the lab is kept until each node confirms. Stay on the detail page.
  const fid = putFlash(
    `Tearing down ${res!.teardownStarted} placement(s). The lab is removed once every node confirms; delete again then.`,
  );
  redirect(`/labs/${labId}?saved=${fid}`);
}

/** Grant a lab access to a node: create a placement and provision the current roster. */
export async function grantNodeAccessAction(formData: FormData) {
  const who = await actor();
  const labId = Number(formData.get("labId"));
  const nodeId = Number(formData.get("nodeId"));
  const image = String(formData.get("image") ?? "").trim() || "ghcr.io/ec061/custom-ssh:latest";
  const coldTb = formData.get("coldTb");
  try {
    if (!labId || !nodeId) throw new Error("Lab and node are required");
    await createPlacement({
      labId,
      nodeId,
      fastQuotaBytes: tbToBytes(formData.get("fastTb"), "Fast"),
      coldQuotaBytes: coldTb === null || coldTb === "" ? null : tbToBytes(coldTb, "Cold"),
      studentFastQuotaBytes: formData.get("enableStudentFastQuota") === "on"
        ? tbToBytes(formData.get("studentFastTb"), "Per-student fast") : null,
      studentColdQuotaBytes: formData.get("enableStudentColdQuota") === "on"
        ? tbToBytes(formData.get("studentColdTb"), "Per-student cold") : null,
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
  const fastAmount = formData.get("fastAmount");
  const coldAmount = formData.get("coldAmount");
  try {
    updatePlacementQuota(
      placementId,
      {
        fastQuotaBytes:
          fastAmount !== null && fastAmount !== ""
            ? amountToBytes(fastAmount, formData.get("fastUnit"), "Fast")
            : undefined,
        // SMB clients have no local cold quota; their owner placement is linked from the page.
        coldQuotaBytes:
          placement.cold_quota_bytes !== null && coldAmount !== null && coldAmount !== ""
            ? amountToBytes(coldAmount, formData.get("coldUnit"), "Cold")
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
  const image = String(formData.get("image") ?? "").trim() || "ghcr.io/ec061/custom-ssh:latest";
  const containerOptions = containerOptionsFromForm(formData);
  try {
    recreatePlacement(placementId, {
      image,
      containerOptions,
      studentFastQuotaBytes: formData.get("enableStudentFastQuota") === "on"
        ? tbToBytes(formData.get("studentFastTb"), "Per-student fast") : null,
      studentColdQuotaBytes: placement!.node_cold_backend !== "smb" && formData.get("enableStudentColdQuota") === "on"
        ? tbToBytes(formData.get("studentColdTb"), "Per-student cold") : null,
    }, who);
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

export async function revealPlacementCredentialAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  const studentId = Number(formData.get("studentId"));
  const placement = getPlacement(placementId);
  if (!placement) redirect("/labs");
  let revealed: { username: string; password: string } | null = null;
  try {
    revealed = consumePlacementCredential(placementId, studentId, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not reveal credential");
    redirect(`/labs/${placement!.lab_id}/placements/${placementId}?error=${fid}`);
  }
  const fid = putFlash(revealed!.password);
  redirect(
    `/labs/${placement!.lab_id}/placements/${placementId}?credential=${fid}&username=${encodeURIComponent(revealed!.username)}`,
  );
}

export async function removePlacementAction(formData: FormData) {
  const who = await actor();
  const placementId = Number(formData.get("placementId"));
  // "force" drops the placement record immediately instead of waiting for the (offline) node to
  // confirm teardown; forceDeletePlacement refuses it while the node is online.
  const force = formData.get("force") === "1";
  const placement = getPlacement(placementId);
  // Already gone (e.g. the node confirmed teardown while the page was open): land on the labs list
  // instead of re-rendering a placement page that no longer exists.
  if (!placement) redirect("/labs");
  try {
    if (force) forceDeletePlacement(placementId, who);
    else destroyPlacement(placementId, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not remove placement");
    redirect(`/labs/${placement!.lab_id}/placements/${placementId}?error=${fid}`);
  }
  revalidatePath(`/labs/${placement.lab_id}`);
  revalidatePath(`/labs/${placement.lab_id}/placements/${placement.id}`);
  // Don't send the user back to the placement's own page: the row (and that page) disappears
  // as soon as the node confirms teardown, which can race the redirect.
  const fid = putFlash(
    force
      ? "Placement force-removed from the controller. If the node ever reconnects, its leftover container and data are cleaned up then."
      : "Removal queued. The placement remains visible on the lab page until the node confirms destruction.",
  );
  redirect(`/labs/${placement.lab_id}?saved=${fid}`);
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
  const msg =
    n === 0
      ? `Added ${username} to the roster. They are provisioned automatically when the lab is granted node access.`
      : `Added ${username}; provisioning queued on ${n} node(s). Credentials are delivered only after each node confirms success.`;
  const fid = putFlash(msg);
  redirect(`/labs/${labId}?saved=${fid}`);
}

/** Preview a per-lab roster CSV import: validate the whole file against the DB without writing anything. */
export async function previewRosterImportAction(labId: number, text: string): Promise<RosterImportPlan> {
  await requireAdmin();
  return planRosterImport(Number(labId), String(text ?? ""));
}

/** Apply a previewed per-lab roster CSV import in one transaction. */
export async function applyRosterImportAction(
  labId: number,
  text: string,
): Promise<{ result?: RosterImportResult; error?: string }> {
  const who = await actor();
  try {
    const result = await applyRosterImport(Number(labId), String(text ?? ""), who);
    revalidatePath(`/labs/${Number(labId)}`);
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
  try {
    removeStudentFromLab(labId, studentId, deleteData, who);
  } catch (e) {
    const fid = putFlash(e instanceof Error ? e.message : "Could not remove student");
    redirect(`/labs/${labId}?error=${fid}`);
  }
  revalidatePath(`/labs/${labId}`);
  revalidatePath("/students");
  const fid = putFlash(
    deleteData
      ? "Student removed from the roster; their account and data are being deleted on every node."
      : "Student removed from the roster; their account is being deprovisioned on every node (data kept).",
  );
  redirect(`/labs/${labId}?saved=${fid}`);
}

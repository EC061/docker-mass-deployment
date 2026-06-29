"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { putFlash } from "@/lib/flash";
import {
  type ColdBackend,
  deleteNode,
  isValidNodeName,
  provisionNode,
  revokeNode,
  rotateNodeToken,
  setNodeAlias,
  setNodeColdStorage,
} from "@/lib/nodes";

// The freshly issued token is shown once on the Nodes page so the admin can paste the printed
// `lab-agent set-token` command onto the node. The cleartext NEVER goes in the redirect URL (it
// would land in browser history / proxy access logs); instead it is stashed in the one-time
// server-side flash store and the redirect carries only an opaque id, read+deleted on next render.
function showToken(name: string, token: string): never {
  const flash = putFlash(token);
  redirect(`/nodes?provisioned=${encodeURIComponent(name)}&token_flash=${flash}`);
}

export async function provisionNodeAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  if (!isValidNodeName(name)) {
    redirect("/nodes?error=Invalid+node+name+(use+a-z+0-9+and+hyphen)");
  }
  const token = provisionNode(name, admin.email);
  showToken(name, token);
}

export async function rotateNodeTokenAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const token = rotateNodeToken(name, admin.email);
  showToken(name, token);
}

export async function revokeNodeAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  revokeNode(name, admin.email);
  redirect("/nodes?revoked=" + encodeURIComponent(name));
}

export async function setNodeAliasAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const alias = String(formData.get("alias") ?? "");
  let error: string | null = null;
  try {
    setNodeAlias(name, alias, admin.email);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not set alias";
  }
  if (error) redirect("/nodes?error=" + encodeURIComponent(error));
  redirect("/nodes");
}

export async function setNodeColdStorageAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const backend = String(formData.get("backend") ?? "local_zfs") as ColdBackend;
  const ownerName = String(formData.get("ownerName") ?? "").trim().toLowerCase() || null;
  let error: string | null = null;
  try {
    setNodeColdStorage(name, backend, backend === "smb" ? ownerName : null, admin.email);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not update cold storage";
  }
  if (error) redirect("/nodes?error=" + encodeURIComponent(error));
  redirect("/nodes");
}

export async function deleteNodeAction(formData: FormData) {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  // deleteNode throws if labs are still pinned to the node; surface that as an error banner.
  // (redirect() throws NEXT_REDIRECT internally, so it must be called OUTSIDE the try/catch.)
  let error: string | null = null;
  try {
    deleteNode(name, admin.email);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not delete node";
  }
  if (error) redirect("/nodes?error=" + encodeURIComponent(error));
  redirect("/nodes?deleted=" + encodeURIComponent(name));
}

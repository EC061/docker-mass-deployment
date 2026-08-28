"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { putFlash } from "@/lib/flash";
import { enqueueTask } from "@/lib/queue";
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
  // "force" purges an OFFLINE node's placements from the controller instead of refusing; the UI only
  // offers it when the node is offline, and deleteNode re-checks that server-side.
  const force = formData.get("force") === "1";
  // deleteNode throws if labs are still pinned to the node; surface that as an error banner.
  // (redirect() throws NEXT_REDIRECT internally, so it must be called OUTSIDE the try/catch.)
  let error: string | null = null;
  try {
    deleteNode(name, admin.email, force);
  } catch (e) {
    error = e instanceof Error ? e.message : "could not delete node";
  }
  if (error) redirect("/nodes?error=" + encodeURIComponent(error));
  redirect("/nodes?deleted=" + encodeURIComponent(name));
}

function nodeTask(formData: FormData, action: string, actor: string): string {
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  if (!isValidNodeName(name)) throw new Error("invalid node name");
  enqueueTask(name, action, {}, actor);
  return name;
}

// UI-created/attached pools back mergerfs tiers, whose branch-list syntax reserves `:`.
const ZFS_POOL_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,62}$/;
const DEVICE_RE = /^\/dev\/disk\/(by-id|by-path)\/[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;

function storageTarget(formData: FormData): { name: string; tier?: "fast" | "cold" } {
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  if (!isValidNodeName(name)) throw new Error("invalid node name");
  const rawTier = formData.get("tier");
  if (rawTier == null) return { name };
  const tier = String(rawTier);
  if (tier !== "fast" && tier !== "cold") throw new Error("invalid storage tier");
  return { name, tier };
}

function storageRedirect(name: string, message: string): never {
  redirect(`/nodes/${encodeURIComponent(name)}/storage?message=${encodeURIComponent(message)}`);
}

export async function refreshStorageAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name } = storageTarget(formData);
  enqueueTask(name, "storage.status", { devices: true }, actor);
  storageRedirect(name, "Storage inventory refresh queued");
}

export async function reconcileStorageAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name } = storageTarget(formData);
  enqueueTask(name, "storage.mount", {}, actor);
  storageRedirect(name, "Storage mount reconciliation queued");
}

export async function rebalanceStorageAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name, tier } = storageTarget(formData);
  enqueueTask(name, "storage.rebalance", tier ? { tier } : {}, actor);
  storageRedirect(name, `${tier ?? "All"} quota rebalance queued`);
}

export async function scrubStoragePoolAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name } = storageTarget(formData);
  const pool = String(formData.get("pool") ?? "");
  if (!ZFS_POOL_RE.test(pool)) throw new Error("invalid ZFS pool name");
  enqueueTask(name, "node.scrub", { pools: [pool] }, actor);
  storageRedirect(name, `Scrub queued for ${pool}`);
}

export async function attachStoragePoolAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name, tier } = storageTarget(formData);
  const pool = String(formData.get("pool") ?? "");
  if (!tier || !ZFS_POOL_RE.test(pool)) throw new Error("invalid pool or storage tier");
  enqueueTask(name, "storage.attach_pool", { tier, pool }, actor);
  storageRedirect(name, `Attaching ${pool} to ${tier}; existing labs will be extended`);
}

export async function createStoragePoolAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const { name, tier } = storageTarget(formData);
  const pool = String(formData.get("pool") ?? "").trim();
  const device = String(formData.get("device") ?? "").trim();
  if (!tier || !ZFS_POOL_RE.test(pool)) throw new Error("invalid pool name or storage tier");
  if (!DEVICE_RE.test(device)) throw new Error("invalid persistent device identity");
  enqueueTask(name, "storage.create_pool", {
    pool,
    devices: [device],
    vdev_type: "",
    tier,
    confirm: true,
    force: false,
  }, actor);
  storageRedirect(name, `Destructive initialization of ${device} as ${pool} queued`);
}

export async function checkNodeAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const name = nodeTask(formData, "node.check", actor);
  redirect(`/nodes?maintenance=${encodeURIComponent(`Health check queued for ${name}`)}`);
}

export async function repairNodeAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const name = nodeTask(formData, "node.repair", actor);
  redirect(`/nodes?maintenance=${encodeURIComponent(`Safe repair queued for ${name}`)}`);
}

export async function rebootNodeAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const name = nodeTask(formData, "node.reboot", actor);
  redirect(`/nodes?maintenance=${encodeURIComponent(`Reboot queued for ${name}`)}`);
}

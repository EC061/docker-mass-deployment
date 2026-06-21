"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { isValidNodeName, provisionNode, revokeNode, rotateNodeToken } from "@/lib/nodes";

// The freshly issued token is shown once on the Nodes page so the admin can paste the printed
// `lab-agent set-token` command onto the node. It is never stored in plaintext.
function showToken(name: string, token: string): never {
  redirect(`/nodes?provisioned=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`);
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

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { clearGpuEvents } from "@/lib/gpu";

export async function clearGpuEventsAction() {
  const actor = (await requireAdmin()).email;
  const cleared = clearGpuEvents(actor);
  revalidatePath("/gpu");
  redirect(`/gpu?cleared=${encodeURIComponent(`Cleared ${cleared} event${cleared === 1 ? "" : "s"}`)}`);
}

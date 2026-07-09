"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { clearGpuEvents, deleteGpuEvent } from "@/lib/gpu";

export async function clearGpuEventsAction() {
  const actor = (await requireAdmin()).email;
  const cleared = clearGpuEvents(actor);
  revalidatePath("/gpu");
  redirect(`/gpu?cleared=${encodeURIComponent(`Cleared ${cleared} event${cleared === 1 ? "" : "s"}`)}`);
}

export async function deleteGpuEventAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  let msg: string;
  try {
    deleteGpuEvent(Number(formData.get("id")), actor);
    msg = "Event deleted";
  } catch (e) {
    msg = e instanceof Error ? e.message : "could not delete event";
  }
  revalidatePath("/gpu");
  redirect(`/gpu?cleared=${encodeURIComponent(msg)}`);
}

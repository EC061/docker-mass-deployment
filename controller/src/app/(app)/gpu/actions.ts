"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { clearGpuEvents } from "@/lib/gpu";

export async function clearGpuEventsAction() {
  const actor = (await requireAdmin()).email;
  clearGpuEvents(actor);
  revalidatePath("/gpu");
}

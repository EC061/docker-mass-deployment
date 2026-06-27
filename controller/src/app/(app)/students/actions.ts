"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { applyMapping, parseCsv } from "@/lib/csv";
import { addStudentToLab, removeStudentFromLab } from "@/lib/students";

// Upper bound on rows per import — prevents one POST from enqueuing thousands of root-agent useradd
// tasks (H-06). Anything beyond this is rejected outright rather than silently truncated.
const MAX_IMPORT_ROWS = 500;

export async function importCsvAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const labId = Number(formData.get("labId"));
  const text = String(formData.get("csv") ?? "");
  const mapping = {
    username: String(formData.get("colUsername") ?? "username"),
    email: String(formData.get("colEmail") ?? "") || undefined,
    name: String(formData.get("colName") ?? "") || undefined,
    studentId: String(formData.get("colStudentId") ?? "") || undefined,
  };
  if (!labId || !text.trim()) redirect("/students?error=Provide+a+lab+and+CSV+text");

  const parsed = parseCsv(text);
  const rows = applyMapping(parsed, mapping);
  if (rows.length > MAX_IMPORT_ROWS) {
    redirect(`/students?error=${encodeURIComponent(`Too many rows (${rows.length}); max ${MAX_IMPORT_ROWS} per import`)}`);
  }

  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.issues.length > 0) {
      skipped++;
      continue;
    }
    try {
      await addStudentToLab(
        labId,
        { username: row.username, email: row.email, name: row.name, studentId: row.studentId },
        actor,
      );
      added++;
    } catch {
      skipped++;
    }
  }
  redirect(`/students?imported=${added}&skipped=${skipped}`);
}

export async function removeStudentAction(formData: FormData) {
  const actor = (await requireAdmin()).email;
  const labId = Number(formData.get("labId"));
  const studentId = Number(formData.get("studentId"));
  const deleteData = formData.get("deleteData") === "on";
  removeStudentFromLab(labId, studentId, deleteData, actor);
  revalidatePath("/students");
  revalidatePath(`/labs/${labId}`);
  redirect("/students");
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { type RawImportRow, validateImportRows } from "@/lib/csv";
import { addStudentToLab, removeStudentFromLab } from "@/lib/students";

// Upper bound on rows per import — prevents one POST from enqueuing thousands of root-agent useradd
// tasks (H-06). Anything beyond this is rejected outright rather than silently truncated.
const MAX_IMPORT_ROWS = 500;

export interface ImportResult {
  added: number;
  skipped: number;
  error?: string;
}

/**
 * Import students from rows parsed in the browser. The CSV itself never reaches the server — the
 * client parses + maps columns and posts the resulting rows here. We still re-validate every row
 * server-side (the browser is never trusted) and cap the batch, then add each valid student.
 */
export async function importStudentsAction(input: {
  labId: number;
  rows: RawImportRow[];
  requireEmail?: boolean;
}): Promise<ImportResult> {
  const actor = (await requireAdmin()).email;
  const labId = Number(input?.labId);
  if (!labId) return { added: 0, skipped: 0, error: "Select a target lab" };
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  if (rows.length === 0) return { added: 0, skipped: 0, error: "No rows to import" };
  if (rows.length > MAX_IMPORT_ROWS) {
    return { added: 0, skipped: 0, error: `Too many rows (${rows.length}); max ${MAX_IMPORT_ROWS} per import` };
  }

  const validated = validateImportRows(rows, { requireEmail: !!input.requireEmail });
  let added = 0;
  let skipped = 0;
  for (const row of validated) {
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
  revalidatePath("/students");
  return { added, skipped };
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

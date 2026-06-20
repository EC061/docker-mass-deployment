"use server";

import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth";
import { applyMapping, parseCsv } from "@/lib/csv";
import { addStudentToLab } from "@/lib/students";

export async function importCsvAction(formData: FormData) {
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
  const actor = (await currentAdmin())?.email;

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

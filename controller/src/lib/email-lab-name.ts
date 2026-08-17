/**
 * Human-facing lab names used in email. The operational lab name remains the stable identifier for
 * dashboards, containers, datasets, tasks, and audit records; recipients instead see the lab named
 * for its PI.
 */

import { db } from "./db";

/** Format a PI's stored name as the lab name shown to email recipients. */
export function formatEmailLabName(piName: string | null | undefined): string {
  const name = (piName ?? "").trim().replace(/\s+/g, " ");
  if (!name) return "Research Lab";

  // PI names created in the current UI do not include a title, but older imports sometimes do.
  // Normalize those records so emails never say "Dr. Dr. Smith's Lab".
  const withoutTitle = name.replace(/^(?:dr|prof(?:essor)?)\.?\s+/i, "");
  return withoutTitle ? `Dr. ${withoutTitle}'s Lab` : "Research Lab";
}

/** Look up the PI for an operational lab name and return its email-facing display name. */
export function emailLabName(labName: string): string {
  const row = db()
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(labs.pi_name), ''), NULLIF(TRIM(pi.name), '')) AS pi_name
       FROM labs LEFT JOIN students pi ON pi.id = labs.pi_student_id
       WHERE labs.name = ?`,
    )
    .get(labName) as { pi_name: string | null } | undefined;
  return formatEmailLabName(row?.pi_name);
}

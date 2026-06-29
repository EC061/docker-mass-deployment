/**
 * Shared audit-log writer. Lives in its own module so labs/placements/students/nodes can all record
 * audit entries without importing each other (which would create import cycles).
 */

import { db } from "./db";

export function audit(
  actor: string | undefined,
  action: string,
  target?: string,
  detail?: string,
): void {
  db()
    .prepare("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), actor ?? null, action, target ?? null, detail ?? null);
}

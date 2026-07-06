/**
 * A plain-text storage-usage report for one placement (a lab on one node), formatted as the same
 * monospace table the student-facing `labquota` command prints. Rendered into the storage-usage
 * emails an admin sends to a lab's PI (whole roster) or one student (their row marked "(you)"),
 * asking them to clean up files.
 *
 * The numbers come from the latest `storage_samples` row per (placement, student|lab-level, pool) —
 * the same data the Stats page reads (see stats.ts's latestSamples), so this report and the page can
 * never disagree. Per-student fast/cold sizes are the nightly du scan; lab-level fast/cold totals and
 * the shared rootfs (container writable layer) are the agent's frequently-refreshed live numbers.
 */

import { getLab } from "./labs";
import { getPlacement } from "./placements";
import { latestSamples, sampleKey, type Cell } from "./stats";
import { listMembers } from "./students";
import { ago } from "./format";

export interface UsageReportStudent {
  studentId: number;
  username: string;
  name: string | null;
  email: string | null;
}

export interface UsageReport {
  text: string;
  labId: number;
  labName: string;
  nodeName: string;
  piName: string | null;
  piEmail: string | null;
  students: UsageReportStudent[];
}

// Binary byte formatting (B/KiB/MiB/GiB/TiB), matching image/labquota's fmt_bytes so the emailed
// table reads identically to what students see from `labquota` inside the container. This differs
// from lib/format.ts's fmtBytes (which labels binary sizes with decimal units KB/MB), so it is kept
// local rather than shared.
function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  let v = n;
  for (const unit of ["B", "KiB", "MiB", "GiB", "TiB"] as const) {
    if (Math.abs(v) < 1024 || unit === "TiB") {
      return unit === "B" ? `${Math.round(v)} ${unit}` : `${v.toFixed(1)} ${unit}`;
    }
    v /= 1024;
  }
  return `${v.toFixed(1)} TiB`;
}

/** ` (N%)` of a quota (floored, matching labquota), or "" when there's nothing to show a share of. */
function fmtPct(used: number | null, quota: number | null | undefined): string {
  if (used === null || !quota || quota <= 0) return "";
  return ` (${Math.floor((used * 100) / quota)}%)`;
}

/** A lab-level TOTAL cell: `used / quota (pct%)`, or just `used` when the tier has no quota. */
function fmtPair(cell: Cell | undefined): string {
  if (!cell) return "—";
  const base = cell.quota ? `${fmtBytes(cell.used)} / ${fmtBytes(cell.quota)}` : fmtBytes(cell.used);
  return base + fmtPct(cell.used, cell.quota);
}

/** A per-student cell: their usage plus their share of the lab's total quota for that tier. */
function fmtShare(used: number | null, totalQuota: number | null): string {
  if (used === null) return "—";
  return fmtBytes(used) + fmtPct(used, totalQuota);
}

/** Lay rows out as a monospace table, matching labquota: header rule, body, rule, then TOTAL. */
function renderTable(rows: string[][]): string {
  const ncols = rows[0].length;
  const widths = Array.from({ length: ncols }, (_, i) => Math.max(...rows.map((r) => r[i].length)));
  const rule = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1) out.push(rule); // separate the TOTAL row from the students
    out.push(("  " + rows[i].map((c, j) => c.padEnd(widths[j])).join("  ")).trimEnd());
    if (i === 0) out.push(rule);
  }
  return out.join("\n");
}

/**
 * Build the usage report for a placement, or null if the placement doesn't exist. When
 * `highlightStudentId` is given (a student-facing email), that roster member's row is suffixed with
 * "  (you)". Roster members with no scan sample yet render as "—".
 */
export function buildUsageReport(
  placementId: number,
  opts: { highlightStudentId?: number } = {},
): UsageReport | null {
  const placement = getPlacement(placementId);
  if (!placement) return null;
  const lab = getLab(placement.lab_id);

  const samples = latestSamples();
  const cell = (student: number | "L", pool: string) => samples.get(sampleKey(placementId, student, pool));
  const usedOf = (student: number | "L", pool: string) => cell(student, pool)?.used ?? null;

  const fastTotal = cell("L", "fast");
  const coldTotal = cell("L", "cold");
  const rootfsTotal = cell("L", "rootfs");
  const fastQuota = fastTotal?.quota ?? null;
  const coldQuota = coldTotal?.quota ?? null;

  const members = listMembers(placement.lab_id);
  const students: UsageReportStudent[] = members.map((m) => ({
    studentId: m.id,
    username: m.username,
    name: m.name ?? null,
    email: m.email ?? null,
  }));

  // One table: roster sorted by username, then the lab TOTAL. Per-student percentages are shares of
  // the lab's total quota for that tier; rootfs is shared by the whole lab, so (unlike labquota's
  // per-student column) it is rendered once as a shared line below the table.
  const ordered = [...members].sort((a, b) => a.username.localeCompare(b.username));
  const rows: string[][] = [["STUDENT", "HOME (fast)", "COLD (slow)"]];
  for (const m of ordered) {
    const label = m.id === opts.highlightStudentId ? `${m.username}  (you)` : m.username;
    rows.push([label, fmtShare(usedOf(m.id, "fast"), fastQuota), fmtShare(usedOf(m.id, "cold"), coldQuota)]);
  }
  rows.push(["TOTAL", fmtPair(fastTotal), fmtPair(coldTotal)]);

  // Live totals are read from the newest lab-level sample; the per-student rows come from the last
  // nightly (or on-demand) du scan recorded on the placement.
  const liveTs = (["fast", "cold", "rootfs"] as const)
    .map((pool) => cell("L", pool)?.ts)
    .filter((t): t is number => typeof t === "number");
  const liveUpdatedAt = liveTs.length ? Math.max(...liveTs) : null;

  const lines: string[] = [
    `Lab '${placement.lab_name}' on node ${placement.node_name} — storage usage`,
    `  live totals ${ago(liveUpdatedAt)} · per-student scan ${ago(placement.usage_scanned_at)}`,
    "",
    renderTable(rows),
    "",
    `  ROOTFS (shared)  ${fmtPair(rootfsTotal)}`,
  ];
  if (liveUpdatedAt === null) {
    lines.push("", "  (no live lab totals have been reported yet)");
  }

  return {
    text: lines.join("\n"),
    labId: placement.lab_id,
    labName: placement.lab_name,
    nodeName: placement.node_name,
    piName: lab?.pi_name ?? null,
    piEmail: lab?.pi_email ?? null,
    students,
  };
}

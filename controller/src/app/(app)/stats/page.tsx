import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ago, fmtBytes, pct } from "@/lib/format";
import { buildStats, type LabStats } from "@/lib/stats";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScanAutoRefresh } from "./_components/ScanAutoRefresh";
import { usageScanAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Per-lab scan control for the *per-student* (nightly du) section. While that scan is in flight the
 * "Scan now" button is replaced by a live progress indicator; it reappears only once the scan is
 * genuinely done — i.e. the agent has finished *and* the fresh numbers have landed (see `scanPending`
 * in lib/stats). The page-level <ScanAutoRefresh> polls while any scan is pending, so the swap back
 * to the button (and the updated table) happens on its own. When idle, the freshness ("updated Xm
 * ago") is shown, tinted when stale. The button enqueues a usage.scan task on the lab's node.
 */
function ScanControl({ lab }: { lab: LabStats }) {
  if (lab.scanPending) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>Scanning…</span>
        <span className="relative h-1 w-24 overflow-hidden rounded-full bg-muted" role="progressbar">
          <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-indeterminate" />
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <form action={usageScanAction}>
        <input type="hidden" name="placementId" value={lab.placementId} />
        <SubmitButton variant="outline" size="sm" icon={<RefreshCw />} pendingText="Scanning…">
          Scan now
        </SubmitButton>
      </form>
      <span className={lab.scanStale ? "text-amber-500" : "text-muted-foreground"}>
        {lab.usageScannedAt ? `updated ${ago(lab.usageScannedAt)}` : "never scanned"}
      </span>
    </div>
  );
}

function quotaCell(used: number | null, quota: number | null) {
  if (used === null) return <span className="text-muted-foreground">—</span>;
  const p = quota ? pct(used, quota) : null;
  return (
    <>
      {fmtBytes(used)}
      {quota ? (
        <span className="text-muted-foreground">
          {" "}/ {fmtBytes(quota)}
          {p !== null && ` (${p}%)`}
        </span>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function LabBlock({ lab }: { lab: LabStats }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">
        <a href={`/labs/${lab.labId}`} className="text-primary hover:underline">
          {lab.labName}
        </a>{" "}
        <span className="font-normal text-muted-foreground">
          · image {lab.image} · {lab.students.length} student{lab.students.length === 1 ? "" : "s"}
        </span>
      </h4>

      {/* Container-level + lab totals — recomputed by the agent on a ~5-min cadence, not per heartbeat. */}
      <div className="rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Lab storage · checked every 5 min</span>
          <span className={lab.liveStale ? "text-amber-500" : "text-muted-foreground/70"}>
            · {lab.liveUpdatedAt ? `updated ${ago(lab.liveUpdatedAt)}` : "no data yet"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Image (writable layer)"
            value={lab.live.image === null ? <span className="text-muted-foreground">—</span> : fmtBytes(lab.live.image)}
          />
          <Stat label="Fast" value={quotaCell(lab.live.fast.used, lab.live.fast.quota)} />
          <Stat label="Cold" value={quotaCell(lab.live.slow.used, lab.live.slow.quota)} />
        </div>
      </div>

      {/* Per-student breakdown — from the nightly / on-demand du scan, hence a freshness timestamp. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Per-student usage · nightly scan
          </div>
          <ScanControl lab={lab} />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Home (installed)</TableHead>
              <TableHead>Fast</TableHead>
              <TableHead>Cold</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lab.students.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No students enrolled.
                </TableCell>
              </TableRow>
            ) : (
              lab.students.map((s) => (
                <TableRow key={s.studentId}>
                  <TableCell>
                    {s.username}
                    {s.name && <span className="text-xs text-muted-foreground"> · {s.name}</span>}
                  </TableCell>
                  <TableCell>
                    {s.docker === null ? <span className="text-muted-foreground">—</span> : fmtBytes(s.docker)}
                  </TableCell>
                  <TableCell>
                    {s.fast === null ? <span className="text-muted-foreground">—</span> : fmtBytes(s.fast)}
                  </TableCell>
                  <TableCell>
                    {s.slow === null ? <span className="text-muted-foreground">—</span> : fmtBytes(s.slow)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default async function StatsPage() {
  const nodes = buildStats();
  const totalLabs = nodes.reduce((n, x) => n + x.labs.length, 0);
  const anyScanPending = nodes.some((n) => n.labs.some((l) => l.scanPending));

  return (
    <div className="space-y-4">
      <ScanAutoRefresh active={anyScanPending} />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Storage stats</h1>
        <p className="text-sm text-muted-foreground">
          Two kinds of data, shown separately per lab. The{" "}
          <strong className="text-foreground">Lab storage</strong> row (container image writable
          layer, plus Fast/Cold usage against the lab quota) is recomputed on the node about every 5
          minutes. The <strong className="text-foreground">Per-student</strong> table (each
          student&apos;s installed software, scratch and cold-storage) comes from a once-a-day scan
          (by default at midnight). Both carry an &ldquo;updated&rdquo; time, and{" "}
          <strong className="text-foreground">Scan now</strong> refreshes both on demand.
        </p>
      </div>

      {totalLabs === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">No labs yet.</p>
          </CardContent>
        </Card>
      ) : (
        nodes.map((node) => (
          <Card key={node.node}>
            <CardContent className="space-y-4">
              <h3 className="text-base font-semibold">
                {node.node}{" "}
                <Badge variant={node.online ? "ok" : "err"}>{node.online ? "online" : "offline"}</Badge>
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}· whole-image usage on this node: {fmtBytes(node.totalImageBytes)}
                </span>
              </h3>

              {node.labs.map((lab) => (
                <LabBlock key={lab.labId} lab={lab} />
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

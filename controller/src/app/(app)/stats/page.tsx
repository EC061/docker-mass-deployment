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
 * Per-lab scan control. While a per-student usage (du) scan is in flight the "Scan now" button is
 * replaced by a live progress indicator; it reappears only once the scan is genuinely done — i.e.
 * the agent has finished *and* the fresh numbers have landed (see `scanPending` in lib/stats). The
 * page-level <ScanAutoRefresh> polls while any scan is pending, so the swap back to the button (and
 * the updated table) happens on its own. When idle, the freshness ("updated Xm ago") is shown,
 * tinted when stale. The button enqueues a usage.scan task on the lab's node.
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
        <input type="hidden" name="labId" value={lab.labId} />
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
          Per-student storage by node and lab. <strong className="text-foreground">Image</strong> is a
          student&apos;s writable-layer (overlayfs) usage; <strong className="text-foreground">Fast</strong>{" "}
          is scratch; <strong className="text-foreground">Cold</strong> is cold storage. Per-student
          Fast/Cold come from a periodic per-lab <em>du</em> scan (use <strong className="text-foreground">Scan
          now</strong> to refresh); the <strong className="text-foreground">Lab total</strong> row shows
          live usage against the lab quota.
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
                <Badge variant={node.online ? "ok" : "err"}>
                  {node.online ? "online" : "offline"}
                </Badge>
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}· whole-image usage on this node: {fmtBytes(node.totalImageBytes)}
                </span>
              </h3>

              {node.labs.map((lab) => (
                <div key={lab.labId} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">
                      <a href={`/labs/${lab.labId}`} className="text-primary hover:underline">
                        {lab.labName}
                      </a>{" "}
                      <span className="font-normal text-muted-foreground">
                        · image {lab.image} · {lab.students.length} student
                        {lab.students.length === 1 ? "" : "s"}
                      </span>
                    </h4>
                    <ScanControl lab={lab} />
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Student</TableHead>
                        <TableHead>Image (overlay)</TableHead>
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
                              {s.name && (
                                <span className="text-xs text-muted-foreground"> · {s.name}</span>
                              )}
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
                      <TableRow className="border-t-2 border-border font-semibold">
                        <TableCell>Lab total (whole image)</TableCell>
                        <TableCell>
                          {lab.aggregate.docker === null ? <span className="text-muted-foreground">—</span> : fmtBytes(lab.aggregate.docker)}
                        </TableCell>
                        <TableCell>{quotaCell(lab.aggregate.fast.used, lab.aggregate.fast.quota)}</TableCell>
                        <TableCell>{quotaCell(lab.aggregate.slow.used, lab.aggregate.slow.quota)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

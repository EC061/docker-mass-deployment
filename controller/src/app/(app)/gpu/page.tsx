import { db } from "@/lib/db";
import { ago, fmtBytes, fmtDuration } from "@/lib/format";
import { groupGpuEvents, recentGpuEvents, type StudentKillStats } from "@/lib/gpu";
import { ConfirmButton } from "../_components/ConfirmButton";
import { clearGpuEventsAction } from "./actions";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

interface SnapRow {
  node: string;
  pid: number;
  user: string | null;
  lab: string | null;
  vram_bytes: number | null;
  util: number | null;
  ts: number;
}

function countBadges(s: { killed: number; warned: number }) {
  return (
    <span className="flex items-center gap-3 text-sm tabular-nums">
      <span className={s.killed > 0 ? "text-err" : "text-muted-foreground"}>{s.killed} killed</span>
      <span className={s.warned > 0 ? "text-warn" : "text-muted-foreground"}>{s.warned} warned</span>
    </span>
  );
}

function StudentDetails({ student }: { student: StudentKillStats }) {
  return (
    <details className="rounded-md border">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-muted/50">
        <span className="text-sm font-medium">{student.user ?? "(unknown user)"}</span>
        <span className="flex items-center gap-3">
          {countBadges(student)}
          <span className="text-xs text-muted-foreground">last {ago(student.lastTs)}</span>
        </span>
      </summary>
      <div className="border-t px-3 pb-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Node</TableHead>
              <TableHead>PID</TableHead>
              <TableHead>Process</TableHead>
              <TableHead>Idle for</TableHead>
              <TableHead>VRAM</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {student.events.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{ago(e.ts)}</TableCell>
                <TableCell>{e.node}</TableCell>
                <TableCell>{e.pid ?? "—"}</TableCell>
                <TableCell className="max-w-md break-all font-mono text-xs">{e.cmd ?? "—"}</TableCell>
                <TableCell>{fmtDuration(e.idle_s)}</TableCell>
                <TableCell>{fmtBytes(e.vram_bytes)}</TableCell>
                <TableCell className={e.state === "killed" ? "text-err" : "text-warn"}>
                  {e.state}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

export default async function GpuPage({
  searchParams,
}: {
  searchParams: Promise<{ cleared?: string }>;
}) {
  const { cleared } = await searchParams;
  const snapshot = db()
    .prepare("SELECT * FROM gpu_snapshot ORDER BY node, vram_bytes DESC")
    .all() as SnapRow[];
  const events = recentGpuEvents();
  const labStats = groupGpuEvents(events);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">GPU</h1>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Live processes</h3>
          {snapshot.length === 0 ? (
            <p className="text-sm text-muted-foreground">No GPU processes reported.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node</TableHead>
                  <TableHead>PID</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Lab</TableHead>
                  <TableHead>VRAM</TableHead>
                  <TableHead>Util %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.map((r) => (
                  <TableRow key={`${r.node}-${r.pid}`}>
                    <TableCell>{r.node}</TableCell>
                    <TableCell>{r.pid}</TableCell>
                    <TableCell>{r.user ?? "—"}</TableCell>
                    <TableCell>{r.lab ?? "—"}</TableCell>
                    <TableCell>{fmtBytes(r.vram_bytes)}</TableCell>
                    <TableCell className={(r.util ?? 0) <= 5 ? "text-warn" : undefined}>
                      {r.util ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Idle-kill events by lab</h3>
            {cleared && <p className="text-sm text-primary">{cleared}</p>}
            {events.length > 0 ? (
              <form action={clearGpuEventsAction}>
                <ConfirmButton
                  size="sm"
                  title="Clear GPU events?"
                  confirmLabel="Clear events"
                  confirm="Clear all recorded GPU idle-kill events? This cannot be undone and does not affect live GPU processes."
                >
                  Clear events
                </ConfirmButton>
              </form>
            ) : null}
          </div>
          {labStats.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <div className="space-y-2">
              {labStats.map((lab) => (
                <details key={lab.lab ?? "(none)"} className="rounded-md border">
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-muted/50">
                    <span className="text-sm font-semibold">{lab.lab ?? "(no lab)"}</span>
                    <span className="flex items-center gap-3">
                      {countBadges(lab)}
                      <span className="text-xs text-muted-foreground">
                        {lab.students.length} student{lab.students.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </summary>
                  <div className="space-y-2 border-t p-3">
                    {lab.students.map((s) => (
                      <StudentDetails key={s.user ?? "(none)"} student={s} />
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

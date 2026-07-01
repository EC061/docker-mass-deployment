import { db } from "@/lib/db";
import { ago, fmtBytes } from "@/lib/format";
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

interface EventRow {
  id: number;
  node: string;
  pid: number | null;
  user: string | null;
  lab: string | null;
  state: string;
  ts: number;
}

export default function GpuPage() {
  const snapshot = db()
    .prepare("SELECT * FROM gpu_snapshot ORDER BY node, vram_bytes DESC")
    .all() as SnapRow[];
  const events = db()
    .prepare("SELECT * FROM gpu_events ORDER BY ts DESC LIMIT 100")
    .all() as EventRow[];

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
            <h3 className="text-base font-semibold">Recent idle-kill events</h3>
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
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Node</TableHead>
                  <TableHead>PID</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Lab</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground">{ago(e.ts)}</TableCell>
                    <TableCell>{e.node}</TableCell>
                    <TableCell>{e.pid ?? "—"}</TableCell>
                    <TableCell>{e.user ?? "—"}</TableCell>
                    <TableCell>{e.lab ?? "—"}</TableCell>
                    <TableCell className={e.state === "killed" ? "text-err" : "text-warn"}>
                      {e.state}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

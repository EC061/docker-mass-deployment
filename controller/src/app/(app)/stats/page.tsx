import { fmtBytes, pct } from "@/lib/format";
import { buildStats } from "@/lib/stats";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

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

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Storage stats</h1>
        <p className="text-sm text-muted-foreground">
          Per-student storage by node and lab. <strong className="text-foreground">Image</strong> is a
          student&apos;s writable-layer (overlayfs) usage; <strong className="text-foreground">Fast</strong>{" "}
          is scratch; <strong className="text-foreground">Cold</strong> is cold storage. Fast/Cold are
          usually reported only at the lab level (the lab quota covers all students). Numbers come from
          the latest agent usage report.
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
                  <h4 className="text-sm font-semibold">
                    <a href={`/labs/${lab.labId}`} className="text-primary hover:underline">
                      {lab.labName}
                    </a>{" "}
                    <span className="font-normal text-muted-foreground">
                      · image {lab.image} · {lab.students.length} student
                      {lab.students.length === 1 ? "" : "s"}
                    </span>
                  </h4>
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

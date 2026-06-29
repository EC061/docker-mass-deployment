import { takeFlash } from "@/lib/flash";
import { listLabPlacementSummaries, listLabs } from "@/lib/labs";
import Link from "next/link";
import { applyLabImportAction, createLabAction, previewLabImportAction } from "./actions";
import { CreateLabForm, type LabTemplate } from "./_components/CreateLabForm";
import { LabImportForm } from "./_components/LabImportForm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function LabsPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string }>;
}) {
  const { imported } = await searchParams;
  const importedMsg = imported ? takeFlash(imported) : null;
  const labs = listLabs();
  const placementsByLab = new Map<number, ReturnType<typeof listLabPlacementSummaries>>();
  for (const placement of listLabPlacementSummaries()) {
    const placements = placementsByLab.get(placement.lab_id) ?? [];
    placements.push(placement);
    placementsByLab.set(placement.lab_id, placements);
  }
  const templates: LabTemplate[] = labs.map((l) => ({ id: l.id, name: l.name }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Labs</h1>

      {importedMsg && (
        <Card className="border-primary/50">
          <CardContent>
            <p className="text-sm text-primary">{importedMsg}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Create lab</h3>
            <p className="text-xs text-muted-foreground">
              A lab is node-independent: create it here, manage its roster, then grant it access to
              one or more nodes from the lab page.
            </p>
          </div>
          <CreateLabForm labs={templates} action={createLabAction} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Import labs &amp; rosters from CSV</h3>
          <LabImportForm preview={previewLabImportAction} apply={applyLabImportAction} />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {labs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No labs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lab</TableHead>
                  <TableHead>PI</TableHead>
                  <TableHead>Students</TableHead>
                  <TableHead>Nodes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {labs.map((lab) => (
                  <TableRow key={lab.id}>
                    <TableCell>
                      <Link href={`/labs/${lab.id}`} className="font-medium text-primary hover:underline">
                        {lab.name}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {lab.pi_name ?? "—"}
                      {lab.pi_email ? <span className="text-muted-foreground"> · {lab.pi_email}</span> : null}
                    </TableCell>
                    <TableCell>{lab.student_count}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {lab.placement_count === 0 ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {(placementsByLab.get(lab.id) ?? []).map((placement) => (
                            <Link
                              key={placement.id}
                              href={`/labs/${lab.id}/placements/${placement.id}`}
                            >
                              <Badge variant={placement.state === "active" ? "ok" : placement.state === "failed" ? "err" : "warn"}>
                                {placement.node_name}: {placement.state}
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      )}
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

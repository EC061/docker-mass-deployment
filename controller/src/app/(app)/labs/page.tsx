import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { fmtBytes, pct } from "@/lib/format";
import { containerOptionsOf, listLabs } from "@/lib/labs";
import { getSettings, TIB } from "@/lib/settings";
import { createLabAction } from "./actions";
import { CreateLabForm, type LabTemplate, type NodeOpt } from "./_components/CreateLabForm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

function latestUsage(labId: number, pool: string): { used: number; quota: number | null } | null {
  const row = db()
    .prepare(
      `SELECT used_bytes, quota_bytes FROM storage_samples
       WHERE lab_id = ? AND student_id IS NULL AND pool = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(labId, pool) as { used_bytes: number; quota_bytes: number | null } | undefined;
  return row ? { used: row.used_bytes, quota: row.quota_bytes } : null;
}

export default async function LabsPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string }>;
}) {
  const { imported } = await searchParams;
  const importedMsg = imported ? takeFlash(imported) : null;
  const labs = listLabs();
  const nodes = db().prepare("SELECT id, name, online FROM nodes ORDER BY name").all() as NodeOpt[];
  const settings = getSettings();

  const templates: LabTemplate[] = labs.map((l) => {
    const opts = containerOptionsOf(l);
    return {
      id: l.id,
      name: l.name,
      image: l.image,
      fastTb: l.fast_quota_bytes / TIB,
      slowTb: l.slow_quota_bytes / TIB,
      cpus: opts.cpus,
      memory: opts.memory,
      shmSize: opts.shm_size,
      imageQuota: opts.image_quota,
      restart: opts.restart,
    };
  });

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
          <h3 className="text-base font-semibold">Create lab</h3>
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect a node first — a lab is pinned to one node.
            </p>
          ) : (
            <CreateLabForm
              nodes={nodes}
              labs={templates}
              defaultFastTb={settings.fastQuotaDefaultBytes / TIB}
              defaultSlowTb={settings.slowQuotaDefaultBytes / TIB}
              action={createLabAction}
            />
          )}
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
                  <TableHead>Node</TableHead>
                  <TableHead>Fast</TableHead>
                  <TableHead>Slow</TableHead>
                  <TableHead>SSH</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {labs.map((lab) => {
                  const fast = latestUsage(lab.id, "fast");
                  const slow = latestUsage(lab.id, "slow");
                  return (
                    <TableRow key={lab.id}>
                      <TableCell>
                        <a href={`/labs/${lab.id}`} className="font-medium text-primary hover:underline">
                          {lab.name}
                        </a>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {lab.node_name}{" "}
                        <Badge variant={lab.online ? "ok" : "err"}>
                          {lab.online ? "online" : "offline"}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {fmtBytes(fast?.used ?? 0)} / {fmtBytes(lab.fast_quota_bytes)}
                        {fast && pct(fast.used, lab.fast_quota_bytes) !== null
                          ? ` (${pct(fast.used, lab.fast_quota_bytes)}%)`
                          : ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {fmtBytes(slow?.used ?? 0)} / {fmtBytes(lab.slow_quota_bytes)}
                      </TableCell>
                      <TableCell>{lab.ssh_port ?? "—"}</TableCell>
                      <TableCell>{lab.status}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

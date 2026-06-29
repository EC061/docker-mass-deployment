import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "../../../../_components/ConfirmButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { fmtBytes, pct } from "@/lib/format";
import {
  containerOptionsOf,
  getPlacement,
  listPlacementMembers,
  listPlacements,
  type Placement,
} from "@/lib/placements";
import { getSetting, TIB } from "@/lib/settings";
import {
  removePlacementAction,
  retryPlacementAction,
  setPlacementQuotaAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

const STATE_VARIANT: Record<string, "ok" | "warn" | "err"> = {
  active: "ok",
  queued: "warn",
  provisioning: "warn",
  deleting: "warn",
  failed: "err",
  removing: "warn",
};

interface Usage {
  used: number;
  quota: number | null;
  ts: number;
}

interface TaskStatus {
  state: string;
  error: string | null;
  updated_at: number;
}

function latestUsage(placementId: number, pool: string): Usage | null {
  const row = db()
    .prepare(
      `SELECT used_bytes AS used, quota_bytes AS quota, ts FROM storage_samples
       WHERE placement_id = ? AND student_id IS NULL AND pool = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(placementId, pool) as Usage | undefined;
  return row ?? null;
}

function latestTask(placement: Placement, action: string): TaskStatus | null {
  const row = db()
    .prepare(
      `SELECT state, error, updated_at FROM task_log
       WHERE node = ? AND action = ? AND json_extract(params, '$.lab') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(placement.node_name, action, placement.lab_name) as TaskStatus | undefined;
  return row ?? null;
}

function taskLabel(task: TaskStatus | null): { text: string; variant: "ok" | "warn" | "err" } | null {
  if (!task) return null;
  if (task.state === "ok") return { text: "applied", variant: "ok" };
  if (task.state === "failed") return { text: "failed", variant: "err" };
  return { text: "queued", variant: "warn" };
}

function QuotaStatus({ desired, usage }: { desired: number; usage: Usage | null }) {
  const percent = usage ? pct(usage.used, desired) : null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Desired {fmtBytes(desired)} · agent reported {usage?.quota ? fmtBytes(usage.quota) : "—"} · used{" "}
      {usage ? fmtBytes(usage.used) : "—"}{percent !== null ? ` (${percent}%)` : ""}
    </p>
  );
}

export default async function PlacementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; placementId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id, placementId } = await params;
  const { saved, error } = await searchParams;
  const placement = getPlacement(Number(placementId));
  if (!placement || placement.lab_id !== Number(id)) notFound();

  const savedMsg = saved ? takeFlash(saved) : null;
  const errorMsg = error ? takeFlash(error) : null;
  const members = listPlacementMembers(placement.id);
  const labPlacements = listPlacements(placement.lab_id);
  const ownerPlacement = placement.node_cold_owner_node_id
    ? labPlacements.find((candidate) => candidate.node_id === placement.node_cold_owner_node_id)
    : null;
  const clients = labPlacements.filter(
    (candidate) => candidate.node_cold_owner_node_id === placement.node_id,
  );
  const fastUsage = latestUsage(placement.id, "fast");
  const coldUsage = latestUsage(placement.id, "slow");
  const quotaTask = latestTask(placement, "lab.set_quota");
  const quotaState = taskLabel(quotaTask);
  const recreateState = taskLabel(latestTask(placement, "container.recreate"));
  const opts = containerOptionsOf(placement);
  const host = getSetting("sshHostOverride").trim() || placement.node_name;
  const canEdit = placement.state !== "deleting";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href={`/labs/${placement.lab_id}`} className="text-sm text-muted-foreground hover:underline">
          ← {placement.lab_name}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{placement.lab_name} on {placement.node_name}</h1>
          <Badge variant={placement.online ? "ok" : "err"}>{placement.online ? "online" : "offline"}</Badge>
          <Badge variant={STATE_VARIANT[placement.state] ?? "warn"}>{placement.state}</Badge>
        </div>
      </div>

      {savedMsg ? (
        <Card className="border-primary/50"><CardContent><p className="text-sm text-primary">{savedMsg}</p></CardContent></Card>
      ) : null}
      {errorMsg ? (
        <Card className="border-destructive/50"><CardContent><p className="text-sm text-destructive">{errorMsg}</p></CardContent></Card>
      ) : null}
      {placement.last_error ? (
        <Card className="border-destructive/50"><CardContent><p className="text-sm text-destructive">{placement.last_error}</p></CardContent></Card>
      ) : null}

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Connection and storage</h2>
          <p className="text-sm">
            SSH <code className="font-mono">ssh -p {placement.ssh_port} &lt;user&gt;@{host}</code>
          </p>
          {placement.node_cold_backend === "smb" ? (
            <p className="text-sm">
              Cold storage is managed by{" "}
              {ownerPlacement ? (
                <Link className="font-medium text-primary hover:underline" href={`/labs/${placement.lab_id}/placements/${ownerPlacement.id}`}>
                  {ownerPlacement.node_name}
                </Link>
              ) : (
                <b>{placement.cold_owner_name ?? "an unconfigured owner"}</b>
              )}
              {ownerPlacement ? ` (${fmtBytes(ownerPlacement.cold_quota_bytes ?? 0)} desired)` : ""}. Mount{" "}
              <code>{placement.node_cold_ready ? "ready" : "not ready"}</code>.
            </p>
          ) : clients.length > 0 ? (
            <p className="text-sm">This placement owns shared cold storage for {clients.map((client) => client.node_name).join(", ")}.</p>
          ) : (
            <p className="text-sm">Fast and cold storage are local ZFS datasets on this node.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Live quotas</h2>
            {quotaState ? <Badge variant={quotaState.variant}>{quotaState.text}</Badge> : null}
          </div>
          {quotaTask?.error ? <p className="text-sm text-destructive">{quotaTask.error}</p> : null}
          <form action={setPlacementQuotaAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input type="hidden" name="placementId" value={placement.id} />
            <div>
              <Label>Fast quota (TB)</Label>
              <Input name="fastTb" type="number" min="0.001" max="100000" step="0.5" defaultValue={placement.fast_quota_bytes / TIB} disabled={!canEdit} />
              <QuotaStatus desired={placement.fast_quota_bytes} usage={fastUsage} />
            </div>
            <div>
              <Label>Cold quota (TB)</Label>
              {placement.cold_quota_bytes === null ? (
                <p className="pt-2 text-sm text-muted-foreground">
                  Managed by {ownerPlacement?.node_name ?? placement.cold_owner_name ?? "owner node"}; change it on the owner placement.
                </p>
              ) : (
                <>
                  <Input name="coldTb" type="number" min="0.001" max="100000" step="0.5" defaultValue={placement.cold_quota_bytes / TIB} disabled={!canEdit} />
                  <QuotaStatus desired={placement.cold_quota_bytes} usage={coldUsage} />
                </>
              )}
            </div>
            <div className="flex items-end"><Button type="submit" disabled={!canEdit}>Apply live</Button></div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Container settings</h2>
            <Badge variant="default">read-only</Badge>
            {recreateState ? <Badge variant={recreateState.variant}>recreate {recreateState.text}</Badge> : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <div><dt className="text-muted-foreground">Image</dt><dd className="font-medium break-all">{placement.image}</dd></div>
            <div><dt className="text-muted-foreground">CPUs</dt><dd className="font-medium">{opts.cpus}</dd></div>
            <div><dt className="text-muted-foreground">Memory</dt><dd className="font-medium">{opts.memory}</dd></div>
            <div><dt className="text-muted-foreground">Shared memory</dt><dd className="font-medium">{opts.shm_size}</dd></div>
            <div><dt className="text-muted-foreground">Image quota</dt><dd className="font-medium">{opts.image_quota}</dd></div>
            <div><dt className="text-muted-foreground">Restart</dt><dd className="font-medium">{opts.restart}</dd></div>
          </dl>
          <Button asChild variant="secondary">
            <Link
              aria-disabled={!canEdit}
              className={!canEdit ? "pointer-events-none opacity-50" : undefined}
              href={`/labs/${placement.lab_id}/placements/${placement.id}/recreate`}
            >
              Recreate container…
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-base font-semibold">Placement roster ({members.length})</h2>
          {members.length === 0 ? <p className="text-sm text-muted-foreground">No students in this placement.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Username</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>{member.username}</TableCell>
                    <TableCell>{member.name ?? "—"}</TableCell>
                    <TableCell><Badge variant={STATE_VARIANT[member.state] ?? "warn"}>{member.state}</Badge></TableCell>
                    <TableCell className="text-destructive">{member.last_error ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          {placement.state === "failed" ? (
            <form action={retryPlacementAction}>
              <input type="hidden" name="placementId" value={placement.id} />
              <Button type="submit">Retry provisioning</Button>
            </form>
          ) : null}
          <form action={removePlacementAction}>
            <input type="hidden" name="placementId" value={placement.id} />
            <ConfirmButton
              variant="destructive"
              disabled={placement.state === "deleting"}
              confirm={`Remove ${placement.lab_name} from ${placement.node_name}? The container and this placement's node-local data are destroyed. Owner cold storage cannot be removed while SMB clients depend on it.`}
            >
              {placement.state === "deleting" ? "Removal queued" : "Remove access"}
            </ConfirmButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

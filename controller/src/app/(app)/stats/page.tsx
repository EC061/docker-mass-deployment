import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ConfirmButton } from "../_components/ConfirmButton";
import { takeFlash } from "@/lib/flash";
import { ago, fmtBytes, pct } from "@/lib/format";
import { listNodeGroups, type NodeGroup } from "@/lib/nodegroups";
import { buildNodeUsage, buildStats, type LabStats, type NodeUsage } from "@/lib/stats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmailReportControl } from "./_components/EmailReportControl";
import { ScanAutoRefresh } from "./_components/ScanAutoRefresh";
import {
  createNodeGroupAction,
  deleteNodeGroupAction,
  emailUsageReportAction,
  refreshAllAction,
  renameNodeGroupAction,
  setNodeGroupMembersAction,
  usageScanAction,
} from "./actions";

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
            label="Rootfs (writable layer)"
            value={lab.live.rootfs === null ? <span className="text-muted-foreground">—</span> : fmtBytes(lab.live.rootfs)}
          />
          <Stat label="Fast" value={quotaCell(lab.live.fast.used, lab.live.fast.quota)} />
          <Stat label="Cold" value={quotaCell(lab.live.cold.used, lab.live.cold.quota)} />
        </div>
      </div>

      {/* Per-student breakdown — from the nightly / on-demand du scan, hence a freshness timestamp. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Per-student usage · nightly scan
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <EmailReportControl lab={lab} sendAction={emailUsageReportAction} />
            <ScanControl lab={lab} />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Home (fast)</TableHead>
              <TableHead>Cold</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lab.students.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
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
                    {s.fast === null ? <span className="text-muted-foreground">—</span> : fmtBytes(s.fast)}
                  </TableCell>
                  <TableCell>
                    {s.cold === null ? <span className="text-muted-foreground">—</span> : fmtBytes(s.cold)}
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

function sumUsed(nodes: NodeUsage[], key: "fastUsed" | "coldUsed"): number | null {
  return nodes.reduce<number | null>((s, n) => (n[key] === null ? s : (s ?? 0) + n[key]!), null);
}

function NodeName({ n }: { n: NodeUsage }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <span className="font-medium">{n.name}</span>
      {n.alias && <span className="text-xs text-muted-foreground">· {n.alias}</span>}
      <Badge variant={n.online ? "ok" : "err"}>{n.online ? "online" : "offline"}</Badge>
    </span>
  );
}

/** Cold cell for a node: SMB clients have no local cold — show the linked normal node instead. */
function coldCell(n: NodeUsage) {
  if (n.coldBackend === "smb") {
    return (
      <span className="text-muted-foreground">
        on {n.coldOwnerName ?? <span className="text-amber-500">no owner</span>}
      </span>
    );
  }
  return quotaCell(n.coldUsed, n.coldQuota);
}

function NodeUsageTable({ nodes }: { nodes: NodeUsage[] }) {
  if (nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No nodes.</p>;
  }
  const fastTotal = sumUsed(nodes, "fastUsed");
  const coldTotal = sumUsed(nodes, "coldUsed");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>Fast</TableHead>
          <TableHead>Cold</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((n) => (
          <TableRow key={n.nodeId}>
            <TableCell><NodeName n={n} /></TableCell>
            <TableCell className="tabular-nums">{quotaCell(n.fastUsed, n.fastQuota)}</TableCell>
            <TableCell className="tabular-nums">{coldCell(n)}</TableCell>
          </TableRow>
        ))}
        {nodes.length > 1 && (
          <TableRow className="border-t-2">
            <TableCell className="font-semibold">Total ({nodes.length} nodes)</TableCell>
            <TableCell className="font-semibold tabular-nums">{fastTotal === null ? "—" : fmtBytes(fastTotal)}</TableCell>
            <TableCell className="font-semibold tabular-nums">{coldTotal === null ? "—" : fmtBytes(coldTotal)}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function GroupBlock({ group, allNodes }: { group: NodeGroup; allNodes: NodeUsage[] }) {
  const memberSet = new Set(group.nodeIds);
  const members = allNodes.filter((n) => memberSet.has(n.nodeId));
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {group.name}{" "}
          <span className="font-normal text-muted-foreground">· {members.length} node{members.length === 1 ? "" : "s"}</span>
        </h4>
        <form action={deleteNodeGroupAction}>
          <input type="hidden" name="groupId" value={group.id} />
          <ConfirmButton
            size="sm"
            variant="ghost"
            title={`Delete group "${group.name}"?`}
            confirmLabel="Delete group"
            confirm={`Delete the node group "${group.name}"? This only removes the grouping; the nodes and their data are untouched.`}
          >
            Delete
          </ConfirmButton>
        </form>
      </div>

      <NodeUsageTable nodes={members} />

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Edit group</summary>
        <div className="mt-3 space-y-4">
          <form action={renameNodeGroupAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="groupId" value={group.id} />
            <Input name="name" defaultValue={group.name} className="h-9 w-48" aria-label="Group name" />
            <Button type="submit" size="sm" variant="secondary">Rename</Button>
          </form>
          <form action={setNodeGroupMembersAction} className="space-y-2">
            <input type="hidden" name="groupId" value={group.id} />
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {allNodes.map((n) => (
                <label key={n.nodeId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="nodeId"
                    value={n.nodeId}
                    defaultChecked={memberSet.has(n.nodeId)}
                    className="accent-primary"
                  />
                  <span>{n.name}{n.alias ? <span className="text-muted-foreground"> · {n.alias}</span> : null}</span>
                </label>
              ))}
            </div>
            <Button type="submit" size="sm">Save nodes</Button>
          </form>
        </div>
      </details>
    </div>
  );
}

function PerNodeUsageSection({
  usage,
  groups,
  flash,
  saved,
}: {
  usage: NodeUsage[];
  groups: NodeGroup[];
  flash: string | null;
  saved: string | null;
}) {
  const grouped = new Set(groups.flatMap((g) => g.nodeIds));
  const ungrouped = usage.filter((n) => !grouped.has(n.nodeId));
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Per-node usage</h3>
          <p className="text-sm text-muted-foreground">
            Storage used on each node&apos;s ZFS pools — fast and cold — reported by the agent every
            heartbeat (used vs. total capacity), so it reflects real on-disk usage even before any lab
            is placed. An SMB node shows fast only; its cold lives on the linked normal node. Create
            named groups to roll up usage across nodes.
          </p>
        </div>

        {flash && <p className="text-sm text-destructive">{flash}</p>}
        {saved && <p className="text-sm text-primary">{saved}</p>}

        {usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No nodes yet.</p>
        ) : (
          <>
            {groups.map((g) => (
              <GroupBlock key={g.id} group={g} allNodes={usage} />
            ))}

            <div className="space-y-3 rounded-md border border-border/60 p-3">
              <h4 className="text-sm font-semibold">
                {groups.length === 0 ? "All nodes" : "Ungrouped"}{" "}
                <span className="font-normal text-muted-foreground">· {ungrouped.length} node{ungrouped.length === 1 ? "" : "s"}</span>
              </h4>
              <NodeUsageTable nodes={ungrouped} />
            </div>
          </>
        )}

        <form action={createNodeGroupAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Input name="name" placeholder="New group name" className="h-9 w-56" aria-label="New group name" required />
          <Button type="submit" size="sm">Create group</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const errorMsg = error ? takeFlash(error) : null;
  const savedMsg = saved ? takeFlash(saved) : null;
  const nodes = buildStats();
  const nodeUsage = buildNodeUsage();
  const groups = listNodeGroups();
  const totalLabs = nodes.reduce((n, x) => n + x.labs.length, 0);
  const anyScanPending = nodes.some((n) => n.labs.some((l) => l.scanPending));

  return (
    <div className="space-y-4">
      <ScanAutoRefresh active={anyScanPending} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Storage stats</h1>
          <p className="text-sm text-muted-foreground">
            Two kinds of data, shown separately per lab. The{" "}
            <strong className="text-foreground">Lab storage</strong> row (container image writable
            layer, plus Fast/Cold usage against the lab quota) is recomputed on the node about every 5
            minutes. The <strong className="text-foreground">Per-student</strong> table (each
            student&apos;s persistent home and cold-storage) comes from a once-a-day scan
            (by default at midnight). Both carry an &ldquo;updated&rdquo; time, and{" "}
            <strong className="text-foreground">Scan now</strong> refreshes both on demand.
          </p>
        </div>
        <form action={refreshAllAction} className="shrink-0">
          <SubmitButton variant="outline" size="sm" icon={<RefreshCw />} pendingText="Refreshing…">
            Refresh all
          </SubmitButton>
        </form>
      </div>

      <PerNodeUsageSection usage={nodeUsage} groups={groups} flash={errorMsg} saved={savedMsg} />

      <h2 className="pt-2 text-lg font-semibold tracking-tight">Per-lab breakdown</h2>

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
                  {" "}· rootfs usage on this node: {fmtBytes(node.totalRootfsBytes)}
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

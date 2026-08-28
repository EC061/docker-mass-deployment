import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "../../../_components/ConfirmButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/lib/db";
import { parseJsonObject, parsePoolTelemetry } from "@/lib/storage";
import {
  attachStoragePoolAction,
  createStoragePoolAction,
  rebalanceStorageAction,
  reconcileStorageAction,
  refreshStorageAction,
  scrubStoragePoolAction,
} from "../../actions";

export const dynamic = "force-dynamic";

interface NodeRow {
  name: string;
  alias: string | null;
  online: number;
  pools: string | null;
  storage_tiers: string | null;
  storage_inventory: string | null;
}

interface TaskRow {
  task_uuid: string;
  action: string;
  state: string;
  error: string | null;
  created_at: number;
}

function fmtBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "GiB", "TiB", "PiB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusVariant(status: string | undefined): "ok" | "warn" | "err" {
  if (status === "healthy" || status === "ONLINE") return "ok";
  if (status === "degraded" || status === "DEGRADED") return "warn";
  return "err";
}

function compactTiers(raw: string | null): Record<string, any> {
  try {
    const rows = raw ? JSON.parse(raw) as any[] : [];
    return Object.fromEntries(rows.map((row) => [row.tier, row]));
  } catch {
    return {};
  }
}

export default async function NodeStoragePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const sp = await searchParams;
  const message = typeof sp.message === "string" ? sp.message : null;
  const node = db().prepare(
    "SELECT name, alias, online, pools, storage_tiers, storage_inventory FROM nodes WHERE name = ?",
  ).get(name) as NodeRow | undefined;
  if (!node) notFound();

  const inventory = parseJsonObject(node.storage_inventory);
  const tiers = inventory?.tiers ?? compactTiers(node.storage_tiers);
  const pools = Array.isArray(inventory?.pools)
    ? inventory.pools as any[]
    : parsePoolTelemetry(node.pools).map((pool) => ({
        name: pool.name,
        size_bytes: pool.size,
        alloc_bytes: pool.alloc,
        free_bytes: pool.free,
        health: pool.health,
        imported: pool.imported,
        tiers: pool.tiers ?? [],
      }));
  const devices = Array.isArray(inventory?.devices) ? inventory.devices as any[] : [];
  const freeDevices = devices.filter((d) => d.by_id && !d.in_use && !d.mounted && !d.zfs_pool);
  const unattachedPools = pools.filter((p) => !Array.isArray(p.tiers) || p.tiers.length === 0);
  const tasks = db().prepare(
    `SELECT task_uuid, action, state, error, created_at FROM task_log
     WHERE node = ? AND (action LIKE 'storage.%' OR action = 'node.scrub')
     ORDER BY created_at DESC LIMIT 12`,
  ).all(name) as TaskRow[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-1 -ml-3">
            <Link href="/nodes">← Nodes</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            Storage · {node.alias ?? node.name}
          </h1>
          {node.alias && <p className="text-sm text-muted-foreground">{node.name}</p>}
        </div>
        <div className="flex gap-2">
          <Badge variant={node.online ? "ok" : "err"}>{node.online ? "online" : "offline"}</Badge>
          <form action={refreshStorageAction}>
            <input type="hidden" name="name" value={node.name} />
            <Button type="submit" variant="secondary" size="sm">Refresh inventory</Button>
          </form>
          <form action={reconcileStorageAction}>
            <input type="hidden" name="name" value={node.name} />
            <Button type="submit" variant="secondary" size="sm">Reconcile mounts</Button>
          </form>
        </div>
      </div>

      {message && <Card className="border-primary/50"><CardContent><p className="text-sm">{message}</p></CardContent></Card>}
      {!inventory && (
        <Card className="border-warn/50"><CardContent>
          <p className="text-sm text-warn">No full inventory has been collected yet. Refresh inventory while the node is online.</p>
        </CardContent></Card>
      )}

      {(["fast", "cold"] as const).map((tierName) => {
        const tier = tiers?.[tierName] ?? {};
        const configuredPools = Array.isArray(tier.pools)
          ? tier.pools.map((p: any) => typeof p === "string" ? p : p.pool)
          : [];
        const tierPools = pools.filter((p) => configuredPools.includes(p.name) || p.tiers?.includes(tierName));
        const logicalCapacity = tier.logical_capacity_bytes ?? tierPools.reduce(
          (sum: number, pool: any) => sum + (Number(pool.size_bytes) || 0), 0,
        );
        const logicalFree = tier.logical_free_bytes ?? tierPools.reduce(
          (sum: number, pool: any) => sum + (Number(pool.free_bytes) || 0), 0,
        );
        return (
          <Card key={tierName}>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold uppercase">{tierName} storage</h2>
                    <Badge variant={statusVariant(tier.health)}>{tier.health ?? "unknown"}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Backend: {tier.backend ?? "unknown"} · Logical path: {tier.mount_root ?? (tierName === "fast" ? "/fast" : "/cold-storage")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Logical backing capacity: {fmtBytes(logicalCapacity)} · Free: {fmtBytes(logicalFree)}
                  </p>
                  {tier.mergerfs && (
                    <p className="text-xs text-muted-foreground">
                      mergerfs: create={tier.mergerfs.create_policy}, move-on-ENOSPC={tier.mergerfs.moveonenospc}, min free={fmtBytes(tier.mergerfs.minfreespace_bytes)}
                    </p>
                  )}
                </div>
                <form action={rebalanceStorageAction}>
                  <input type="hidden" name="name" value={node.name} />
                  <input type="hidden" name="tier" value={tierName} />
                  <Button type="submit" variant="secondary" size="sm">Rebalance quotas</Button>
                </form>
              </div>

              <Table>
                <TableHeader><TableRow>
                  <TableHead>Pool</TableHead><TableHead>Health</TableHead><TableHead>Used</TableHead>
                  <TableHead>Free</TableHead><TableHead>Scrub</TableHead>
                  <TableHead>Devices</TableHead><TableHead />
                </TableRow></TableHeader>
                <TableBody>
                  {tierPools.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="text-muted-foreground">No local pool reported.</TableCell></TableRow>
                  ) : tierPools.map((pool) => (
                    <TableRow key={pool.name}>
                      <TableCell className="font-medium">{pool.name}</TableCell>
                      <TableCell><Badge variant={statusVariant(pool.health)}>{pool.health ?? "unknown"}</Badge></TableCell>
                      <TableCell>{fmtBytes(pool.alloc_bytes)}</TableCell>
                      <TableCell>{fmtBytes(pool.free_bytes)}</TableCell>
                      <TableCell className="max-w-64 text-xs">
                        {pool.scrub?.scrubbing
                          ? "in progress"
                          : pool.scrub?.last_scrub ?? "not reported"}
                        {typeof pool.scrub?.errors === "number" && pool.scrub.errors !== 0
                          ? ` · ${pool.scrub.errors < 0 ? "errors reported" : `${pool.scrub.errors} error(s)`}`
                          : ""}
                      </TableCell>
                      <TableCell className="max-w-72 break-all text-xs">{pool.devices?.join(", ") || "—"}</TableCell>
                      <TableCell>
                        <form action={scrubStoragePoolAction}>
                          <input type="hidden" name="name" value={node.name} />
                          <input type="hidden" name="pool" value={pool.name} />
                          <Button type="submit" variant="secondary" size="sm">Scrub</Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {unattachedPools.length > 0 && (
                <form action={attachStoragePoolAction} className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                  <input type="hidden" name="name" value={node.name} />
                  <input type="hidden" name="tier" value={tierName} />
                  <label className="space-y-1 text-sm">Existing unassigned pool
                    <Select name="pool" required className="min-w-48">
                      <option value="">Select pool…</option>
                      {unattachedPools.map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}
                    </Select>
                  </label>
                  <Button type="submit" variant="secondary">Attach pool</Button>
                </form>
              )}

              <form action={createStoragePoolAction} className="space-y-3 rounded-md border border-warn/40 p-3">
                <input type="hidden" name="name" value={node.name} />
                <input type="hidden" name="tier" value={tierName} />
                <div>
                  <h3 className="font-medium">Add a new drive</h3>
                  <p className="text-xs text-warn">This initializes the selected whole disk as an independent ZFS pool and permanently erases everything on it.</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="space-y-1 text-sm">Physical disk
                    <Select name="device" required className="max-w-xl">
                      <option value="">Select an unused disk…</option>
                      {freeDevices.map((device) => (
                        <option key={device.by_id} value={device.by_id}>
                          {device.model ?? device.name} · {fmtBytes(device.size_bytes)} · {device.by_id}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="space-y-1 text-sm">New pool name
                    <Input name="pool" required pattern="[A-Za-z][A-Za-z0-9_.\-]{0,62}" placeholder={tierName === "fast" ? "fast2" : "cold2"} />
                  </label>
                  <ConfirmButton variant="destructive" confirmLabel="Erase disk and create pool"
                    confirm={`ERASE the selected disk, create a new independent ZFS pool, attach it to ${tierName}, provision every existing lab branch, and redistribute existing quotas? This cannot be undone.`}>
                    Initialize and attach
                  </ConfirmButton>
                </div>
                {freeDevices.length === 0 && <p className="text-xs text-muted-foreground">No unused stable /dev/disk/by-id device is currently reported.</p>}
              </form>

              {inventory?.state?.labs?.[tierName] && (
                <details className="rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Advanced quota allocations</summary>
                  <div className="mt-3 space-y-3">
                    {Object.entries(inventory.state.labs[tierName] as Record<string, any>).map(([lab, record]) => (
                      <div key={lab}>
                        <div className="font-medium">{lab} · configured {fmtBytes(record.configured_quota_bytes)}</div>
                        <div className="text-xs text-muted-foreground">
                          {Object.values(record.branches ?? {}).map((branch: any) =>
                            `${branch.pool}: ${fmtBytes(branch.used_bytes)} used / ${fmtBytes(branch.quota_bytes)} quota (${branch.state})`,
                          ).join(" · ") || "No branches recorded"}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card><CardContent className="space-y-2">
        <h2 className="text-lg font-semibold">Docker storage</h2>
        <p className="text-sm">Pool: {inventory?.docker?.pool ?? "unknown"} · Dataset: {inventory?.docker?.dataset ?? "unknown"} · Data root: {inventory?.docker?.data_root ?? "unknown"}</p>
        <Badge variant={inventory?.docker?.on_zfs ? "ok" : "err"}>
          {inventory?.docker?.on_zfs ? "native ZFS" : "native ZFS not verified"}
        </Badge>
        <p className="text-xs text-muted-foreground">Docker is intentionally separate from the fast lab tier and is never placed on mergerfs.</p>
      </CardContent></Card>

      <Card><CardContent>
        <h2 className="mb-3 text-lg font-semibold">Recent storage operations</h2>
        <Table><TableHeader><TableRow><TableHead>Action</TableHead><TableHead>State</TableHead><TableHead>Time</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
          <TableBody>{tasks.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No storage tasks yet.</TableCell></TableRow> : tasks.map((task) => (
            <TableRow key={task.task_uuid}>
              <TableCell>{task.action}</TableCell>
              <TableCell><Badge variant={task.state === "ok" ? "ok" : task.state === "failed" ? "err" : "warn"}>{task.state}</Badge></TableCell>
              <TableCell>{new Date(task.created_at).toLocaleString()}</TableCell>
              <TableCell className="max-w-xl text-xs text-warn">{task.error ?? ""}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}

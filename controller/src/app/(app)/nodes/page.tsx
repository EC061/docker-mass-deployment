import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { listLocalZfsNodes } from "@/lib/nodes";
import { ConfirmButton } from "../_components/ConfirmButton";
import { ColdStorageForm } from "./_components/ColdStorageForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  deleteNodeAction,
  provisionNodeAction,
  revokeNodeAction,
  rotateNodeTokenAction,
  setNodeAliasAction,
  setNodeColdStorageAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface NodeRow {
  name: string;
  alias: string | null;
  online: number;
  last_seen: number | null;
  capabilities: string | null;
  pools: string | null;
  scrub_status: string | null;
  allowed: number;
  cold_backend: "local_zfs" | "smb";
  owner_name: string | null;
  cold_mount_path: string | null;
  cold_ready: number;
  placements: number;
}

interface ScrubEntry {
  pool: string;
  healthy?: boolean;
  scrubbing?: boolean;
  errors?: number;
  last_scrub?: string | null;
}

function scrubSummary(raw: string | null): { text: string; bad: boolean } {
  if (!raw) return { text: "—", bad: false };
  let entries: ScrubEntry[] = [];
  try {
    entries = JSON.parse(raw) as ScrubEntry[];
  } catch {
    return { text: "—", bad: false };
  }
  if (entries.length === 0) return { text: "—", bad: false };
  const bad = entries.some((p) => p.healthy === false || (typeof p.errors === "number" && p.errors !== 0));
  const text = entries
    .map((p) => {
      if (p.healthy === false || (p.errors && p.errors !== 0)) return `${p.pool}: errors`;
      if (p.scrubbing) return `${p.pool}: scrubbing`;
      return `${p.pool}: ok`;
    })
    .join(", ");
  return { text, bad };
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function authLabel(n: NodeRow): string {
  return n.allowed === 1 ? "per-node" : "revoked";
}

export default async function NodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const provisioned = typeof sp.provisioned === "string" ? sp.provisioned : undefined;
  // The one-time token is carried only as an opaque flash id (never the cleartext) — read + burn it.
  const token = typeof sp.token_flash === "string" ? takeFlash(sp.token_flash) : null;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const deleted = typeof sp.deleted === "string" ? sp.deleted : undefined;

  const nodes = db()
    .prepare(
      `SELECT n.name, n.alias, n.online, n.last_seen, n.capabilities, n.pools, n.scrub_status,
              n.allowed, n.cold_backend, n.cold_mount_path, n.cold_ready,
              owner.name AS owner_name,
              (SELECT COUNT(*) FROM lab_placements WHERE node_id = n.id) AS placements
       FROM nodes n LEFT JOIN nodes owner ON owner.id = n.cold_owner_node_id ORDER BY n.name`,
    )
    .all() as NodeRow[];
  const localZfsNodes = listLocalZfsNodes().map((n) => n.name);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Nodes</h1>

      {error && (
        <Card className="border-warn/50">
          <CardContent>
            <p className="text-sm text-warn">{error}</p>
          </CardContent>
        </Card>
      )}

      {deleted && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">Node “{deleted}” was deleted.</p>
          </CardContent>
        </Card>
      )}

      {provisioned && token && (
        <Card className="border-primary/50">
          <CardContent className="space-y-2">
            <h3 className="text-base font-semibold">Token for node “{provisioned}”</h3>
            <p className="text-sm text-muted-foreground">
              Shown once. Run this on the node, then the agent reconnects automatically:
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
              <code>sudo lab-agent set-token {token}</code>
            </pre>
            <p className="text-xs text-muted-foreground">
              (Equivalent to writing the token into <code>/etc/lab-agent/config.toml</code> and running
              <code> systemctl restart lab-agent</code>.)
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2">
          <h3 className="text-base font-semibold">Register a node</h3>
          <form action={provisionNodeAction} className="flex flex-wrap items-center gap-2">
            <Input
              name="name"
              placeholder="node name (e.g. gpu-01)"
              required
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              className="w-full sm:w-64"
            />
            <Button type="submit">Provision token</Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Adds the node to the allow-list and issues a per-node token. Only allow-listed nodes may
            connect.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No nodes have connected yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>GPUs</TableHead>
                  <TableHead>Pools</TableHead>
                  <TableHead>Cold storage</TableHead>
                  <TableHead>Scrub</TableHead>
                  <TableHead>Issues</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((n) => {
                  const caps = n.capabilities ? JSON.parse(n.capabilities) : {};
                  const pools = n.pools ? JSON.parse(n.pools) : [];
                  const scrub = scrubSummary(n.scrub_status);
                  return (
                    <TableRow key={n.name}>
                      <TableCell>
                        {n.alias ? (
                          <>
                            <div>{n.alias}</div>
                            <div className="text-xs text-muted-foreground">{n.name}</div>
                          </>
                        ) : (
                          n.name
                        )}
                        <form action={setNodeAliasAction} className="mt-1.5 flex gap-1">
                          <input type="hidden" name="name" value={n.name} />
                          <Input
                            name="alias"
                            defaultValue={n.alias ?? ""}
                            placeholder="alias"
                            maxLength={64}
                            className="h-7 w-28 text-xs"
                          />
                          <Button type="submit" variant="secondary" size="sm" className="h-7">
                            Save
                          </Button>
                        </form>
                      </TableCell>
                      <TableCell>
                        <Badge variant={n.online ? "ok" : "err"}>
                          {n.online ? "online" : "offline"}
                        </Badge>
                      </TableCell>
                      <TableCell className={n.allowed !== 1 ? "text-warn" : undefined}>
                        {authLabel(n)}
                      </TableCell>
                      <TableCell>{caps.gpu_count ?? 0}</TableCell>
                      <TableCell>
                        {pools.length === 0
                          ? "—"
                          : pools.map((p: any) => `${p.name}: ${fmtBytes(p.free)} free`).join(", ")}
                      </TableCell>
                      <TableCell>
                        {n.cold_backend === "smb" ? (
                          <span>Managed by {n.owner_name ?? <span className="text-warn">no owner</span>}</span>
                        ) : (
                          <span>local ZFS</span>
                        )}
                        {n.cold_mount_path && (
                          <div className="text-xs text-muted-foreground">
                            {n.cold_mount_path}{" "}
                            <Badge variant={n.cold_ready ? "ok" : "warn"}>{n.cold_ready ? "mounted" : "not mounted"}</Badge>
                          </div>
                        )}
                        {n.placements === 0 ? (
                          <ColdStorageForm
                            name={n.name}
                            backend={n.cold_backend}
                            ownerName={n.owner_name}
                            localZfsNodes={localZfsNodes}
                            action={setNodeColdStorageAction}
                          />
                        ) : (
                          <div className="mt-1 text-xs text-muted-foreground">{n.placements} placement(s) — fixed</div>
                        )}
                      </TableCell>
                      <TableCell className={scrub.bad ? "text-warn" : undefined}>{scrub.text}</TableCell>
                      <TableCell>
                        {caps.issues && caps.issues.length > 0 ? (
                          <span className="text-warn">{caps.issues.length}</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {ago(n.last_seen)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex gap-1.5">
                          <form action={rotateNodeTokenAction}>
                            <input type="hidden" name="name" value={n.name} />
                            <Button type="submit" variant="secondary" size="sm">
                              Rotate
                            </Button>
                          </form>
                          {n.allowed === 1 && (
                            <form action={revokeNodeAction}>
                              <input type="hidden" name="name" value={n.name} />
                              <Button type="submit" variant="secondary" size="sm" className="text-warn">
                                Revoke
                              </Button>
                            </form>
                          )}
                          <form action={deleteNodeAction}>
                            <input type="hidden" name="name" value={n.name} />
                            <ConfirmButton
                              variant="secondary"
                              size="sm"
                              className="text-err"
                              confirm={`Delete node "${n.name}"? This removes it from the controller (it fails if any labs are still pinned to it).`}
                            >
                              Delete
                            </ConfirmButton>
                          </form>
                        </div>
                      </TableCell>
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

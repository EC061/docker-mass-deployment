import { notFound } from "next/navigation";
import { ConfirmButton } from "../../_components/ConfirmButton";
import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { fmtBytes, pct } from "@/lib/format";
import { getLab } from "@/lib/labs";
import { containerOptionsOf, listPlacements, type Placement } from "@/lib/placements";
import { listMembers } from "@/lib/students";
import { getSetting, getSettings, TIB } from "@/lib/settings";
import { PlacementForm, type NodeOpt } from "../_components/PlacementForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addMemberAction,
  destroyLabAction,
  grantNodeAccessAction,
  removeMemberAction,
  removePlacementAction,
  setPlacementQuotaAction,
  updateLabMetaAction,
} from "../actions";

export const dynamic = "force-dynamic";

/** Latest lab-level (student_id NULL) usage for a placement+pool. */
function placementUsage(placementId: number, pool: string): { used: number; quota: number | null } | null {
  const row = db()
    .prepare(
      `SELECT used_bytes, quota_bytes FROM storage_samples
       WHERE placement_id = ? AND student_id IS NULL AND pool = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(placementId, pool) as { used_bytes: number; quota_bytes: number | null } | undefined;
  return row ? { used: row.used_bytes, quota: row.quota_bytes } : null;
}

const STATE_VARIANT: Record<string, "ok" | "warn" | "err"> = {
  active: "ok",
  provisioning: "warn",
  queued: "warn",
  deleting: "warn",
  failed: "err",
};

function PlacementCard({ p }: { p: Placement }) {
  const opts = containerOptionsOf(p);
  const host = getSetting("sshHostOverride").trim() || p.node_name;
  const fast = placementUsage(p.id, "fast");
  const slow = placementUsage(p.id, "slow");
  const isSmbClient = p.cold_quota_bytes === null;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-base font-semibold">{p.node_name}</h4>
          <Badge variant={p.online ? "ok" : "err"}>{p.online ? "online" : "offline"}</Badge>
          <Badge variant={STATE_VARIANT[p.state] ?? "warn"}>{p.state}</Badge>
        </div>
        {p.last_error && p.state === "failed" && (
          <p className="text-xs text-destructive">{p.last_error}</p>
        )}
        <p className="text-sm text-muted-foreground">
          SSH <code className="font-mono">ssh -p {p.ssh_port} &lt;user&gt;@{host}</code> · image {p.image} ·
          {" "}{opts.cpus} CPU · {opts.memory} RAM · img-quota {opts.image_quota}
        </p>

        <form action={setPlacementQuotaAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="placementId" value={p.id} />
          <div>
            <Label>Fast (TB)</Label>
            <Input
              name="fastTb"
              type="number"
              step="0.5"
              defaultValue={p.fast_quota_bytes / TIB}
              className="w-28"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              used {fmtBytes(fast?.used ?? 0)}
              {fast && pct(fast.used, p.fast_quota_bytes) !== null ? ` (${pct(fast.used, p.fast_quota_bytes)}%)` : ""}
            </p>
          </div>
          <div>
            <Label>Cold (TB)</Label>
            <Input
              name="coldTb"
              type="number"
              step="0.5"
              defaultValue={p.cold_quota_bytes !== null ? p.cold_quota_bytes / TIB : ""}
              disabled={isSmbClient}
              className="w-28"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {isSmbClient ? "managed by owner node" : `used ${fmtBytes(slow?.used ?? 0)}`}
            </p>
          </div>
          <Button type="submit">Apply (live)</Button>
        </form>

        <div className="flex flex-wrap items-center gap-3">
          <a href={`/labs/${p.lab_id}/placements/${p.id}/recreate`}>
            <Button type="button" variant="secondary" size="sm">
              Recreate container…
            </Button>
          </a>
          <form action={removePlacementAction}>
            <input type="hidden" name="placementId" value={p.id} />
            <ConfirmButton
              variant="destructive"
              size="sm"
              confirm={`Remove ${p.lab_name} from ${p.node_name}? The container and all of this node's data (shared + every student) are destroyed. Shared cold data on an owner node is removed once, after dependent SMB clients are gone.`}
            >
              Remove access
            </ConfirmButton>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function LabDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ newuser?: string; pwid?: string; emailed?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { newuser, pwid, emailed, saved } = await searchParams;
  const savedMsg = saved ? takeFlash(saved) : null;
  const pw = pwid ? takeFlash(pwid) : null;
  const labId = Number(id);
  const lab = getLab(labId);
  if (!lab) notFound();

  const members = listMembers(labId);
  const placements = listPlacements(labId);
  const placedNodeIds = new Set(placements.map((p) => p.node_id));
  // Candidate nodes for "grant access", with cold-storage readiness: an SMB client is only ready when
  // its owner already hosts this lab (active) and its mount is live.
  interface NodeColdRow {
    id: number;
    name: string;
    online: number;
    cold_backend: "local_zfs" | "smb";
    cold_ready: number;
    owner_name: string | null;
    owner_state: string | null;
  }
  const availableNodes: NodeOpt[] = (db()
    .prepare(
      `SELECT n.id, n.name, n.online, n.cold_backend, n.cold_ready, owner.name AS owner_name,
              (SELECT state FROM lab_placements WHERE lab_id = ? AND node_id = n.cold_owner_node_id) AS owner_state
       FROM nodes n LEFT JOIN nodes owner ON owner.id = n.cold_owner_node_id ORDER BY n.name`,
    )
    .all(labId) as NodeColdRow[])
    .filter((n) => !placedNodeIds.has(n.id))
    .map((n) => {
      let ready = true;
      let blockedReason: string | null = null;
      if (n.cold_backend === "smb") {
        if (!n.owner_name) {
          ready = false;
          blockedReason = "This SMB node has no cold-storage owner configured (set it on the Nodes page).";
        } else if (n.owner_state !== "active") {
          ready = false;
          blockedReason = `Grant the owner '${n.owner_name}' access to this lab first (its placement is ${n.owner_state ?? "missing"}).`;
        } else if (n.cold_ready !== 1) {
          ready = false;
          blockedReason = `The SMB cold-storage mount on '${n.name}' is not active yet.`;
        }
      }
      return { id: n.id, name: n.name, online: n.online, coldBackend: n.cold_backend, ownerName: n.owner_name, ready, blockedReason };
    });
  const settings = getSettings();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Lab: {lab.name}</h1>

      {savedMsg && (
        <Card className="border-primary/50">
          <CardContent>
            <p className="text-sm text-primary">{savedMsg}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">PI / metadata</h3>
          <form action={updateLabMetaAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input type="hidden" name="labId" value={lab.id} />
            <div>
              <Label>PI name</Label>
              <Input name="piName" defaultValue={lab.pi_name ?? ""} placeholder="Dr. Jane Smith" />
            </div>
            <div>
              <Label>PI email</Label>
              <Input name="piEmail" type="email" defaultValue={lab.pi_email ?? ""} placeholder="pi@uga.edu" />
            </div>
            <div className="flex items-end">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Nodes ({placements.length})</h3>
          {placements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This lab has no node access yet — grant it below to provision its container and roster.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {placements.map((p) => (
                <PlacementCard key={p.id} p={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Grant node access</h3>
          <PlacementForm
            labId={lab.id}
            nodes={availableNodes}
            defaultFastTb={settings.fastQuotaDefaultBytes / TIB}
            defaultColdTb={settings.slowQuotaDefaultBytes / TIB}
            action={grantNodeAccessAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Roster ({members.length})</h3>
          {newuser && pw && (
            <div className="rounded-md border border-primary/50 bg-primary/10 px-3 py-2.5 text-sm">
              Added <b>{newuser}</b> — password{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{pw}</code>{" "}
              <span className="text-muted-foreground">
                (shown once{emailed ? "; also emailed" : "; SMTP not configured, not emailed"})
              </span>
            </div>
          )}
          <form action={addMemberAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="labId" value={lab.id} />
            <div>
              <Label>Username</Label>
              <Input name="username" required placeholder="alice" />
            </div>
            <div>
              <Label>Email</Label>
              <Input name="email" type="email" placeholder="alice@uga.edu" />
            </div>
            <div>
              <Label>Name</Label>
              <Input name="name" placeholder="Alice A." />
            </div>
            <div>
              <Label>Student ID</Label>
              <Input name="studentId" placeholder="100001" />
            </div>
            <Button type="submit">Add student</Button>
          </form>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No students yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Student ID</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.member_id}>
                    <TableCell>{m.username}</TableCell>
                    <TableCell>{m.email ?? "—"}</TableCell>
                    <TableCell>{m.name ?? "—"}</TableCell>
                    <TableCell>{m.student_id ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <form action={removeMemberAction} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="labId" value={lab.id} />
                        <input type="hidden" name="studentId" value={m.id} />
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input type="checkbox" name="deleteData" className="accent-primary" /> delete data
                        </label>
                        <ConfirmButton
                          variant="secondary"
                          size="sm"
                          confirm={`Remove ${m.username} from ${lab.name} on every node? If "delete data" is checked, their files are erased (shared cold data once, on the owner).`}
                        >
                          Remove
                        </ConfirmButton>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <form action={destroyLabAction}>
            <input type="hidden" name="labId" value={lab.id} />
            <ConfirmButton
              variant="destructive"
              confirm={
                placements.length > 0
                  ? `Delete lab "${lab.name}"? Its ${placements.length} placement(s) are torn down first (container + data on each node); the lab is removed once every node confirms.`
                  : `Delete lab "${lab.name}"? This removes the lab and its roster, and any student left in no lab.`
              }
            >
              Delete lab
            </ConfirmButton>
          </form>
          <p className="text-xs text-muted-foreground">
            Deleting tears down every placement first; storage on each node is destroyed with it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

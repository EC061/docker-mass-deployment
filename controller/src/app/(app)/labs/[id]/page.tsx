import { notFound } from "next/navigation";
import Link from "next/link";
import { ConfirmButton } from "../../_components/ConfirmButton";
import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { getLab } from "@/lib/labs";
import { listPlacements, type Placement } from "@/lib/placements";
import { listMembers } from "@/lib/students";
import { getSettings, TIB } from "@/lib/settings";
import { PlacementForm, type NodeOpt } from "../_components/PlacementForm";
import { RosterImportForm } from "../_components/RosterImportForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addMemberAction,
  applyRosterImportAction,
  destroyLabAction,
  grantNodeAccessAction,
  previewRosterImportAction,
  removeMemberAction,
  updateLabMetaAction,
} from "../actions";

export const dynamic = "force-dynamic";

const STATE_VARIANT: Record<string, "ok" | "warn" | "err"> = {
  active: "ok",
  provisioning: "warn",
  queued: "warn",
  deleting: "warn",
  failed: "err",
};

function PlacementCard({ p, clients }: { p: Placement; clients: string[] }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{p.node_name}</h3>
          <Badge variant={p.online ? "ok" : "err"}>{p.online ? "online" : "offline"}</Badge>
          <Badge variant={STATE_VARIANT[p.state] ?? "warn"}>{p.state}</Badge>
        </div>
        {p.last_error && p.state === "failed" && (
          <p className="text-xs text-destructive">{p.last_error}</p>
        )}
        <p className="text-sm text-muted-foreground">
          SSH port {p.ssh_port} · image {p.image}
        </p>
        {p.node_cold_backend === "smb" ? (
          <p className="text-sm">Cold storage managed by <b>{p.cold_owner_name ?? "unconfigured owner"}</b>.</p>
        ) : clients.length > 0 ? (
          <p className="text-sm">Cold-storage owner for {clients.join(", ")}.</p>
        ) : (
          <p className="text-sm">Local ZFS cold storage.</p>
        )}
        <Button asChild variant="secondary" size="sm">
          <Link href={`/labs/${p.lab_id}/placements/${p.id}`}>Manage placement</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default async function LabDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;
  const savedMsg = saved ? takeFlash(saved) : null;
  const errorMsg = error ? takeFlash(error) : null;
  const labId = Number(id);
  const lab = getLab(labId);
  if (!lab) notFound();

  const members = listMembers(labId);
  const placements = listPlacements(labId);
  const offlinePlacements = placements.filter((p) => !p.online);
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

      {errorMsg && (
        <Card className="border-destructive/50">
          <CardContent>
            <p className="text-sm text-destructive">{errorMsg}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">PI / metadata</h2>
          <form action={updateLabMetaAction} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <input type="hidden" name="labId" value={lab.id} />
            <div>
              <Label>PI login username</Label>
              <Input
                name="piUsername"
                defaultValue={members.find((member) => member.is_pi)?.username ?? ""}
                readOnly={lab.pi_student_id != null}
                required
                placeholder="jsmith"
              />
            </div>
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
          <h2 className="text-base font-semibold">Nodes ({placements.length})</h2>
          {placements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This lab has no node access yet — grant it below to provision its container and roster.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {placements.map((p) => (
                <PlacementCard
                  key={p.id}
                  p={p}
                  clients={placements
                    .filter((candidate) => candidate.node_cold_owner_node_id === p.node_id)
                    .map((candidate) => candidate.node_name)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Grant node access</h2>
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
          <h2 className="text-base font-semibold">Roster ({members.length})</h2>
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
                      {m.is_pi ? (
                        <Badge variant="default">PI · protected</Badge>
                      ) : (
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
                      )}
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
          <h2 className="text-base font-semibold">Import roster from CSV</h2>
          <RosterImportForm
            labId={lab.id}
            preview={previewRosterImportAction}
            apply={applyRosterImportAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <form action={destroyLabAction}>
            <input type="hidden" name="labId" value={lab.id} />
            <ConfirmButton
              variant="destructive"
              title={`Delete ${lab.name}?`}
              confirmLabel="Delete lab"
              confirm={
                placements.length > 0
                  ? `Delete lab "${lab.name}"? Its ${placements.length} placement(s) are torn down first (container + data on each node); the lab is removed once every node confirms.`
                  : `Delete lab "${lab.name}"? This removes the lab and its roster, and any student left in no lab.`
              }
            >
              Delete lab
            </ConfirmButton>
          </form>
          {offlinePlacements.length > 0 && (
            <form action={destroyLabAction}>
              <input type="hidden" name="labId" value={lab.id} />
              <input type="hidden" name="force" value="1" />
              <ConfirmButton
                variant="destructive"
                title={`Force delete ${lab.name}?`}
                confirmLabel="Force delete lab"
                confirm={`Node(s) ${offlinePlacements.map((p) => p.node_name).join(", ")} are offline and cannot confirm teardown. Force-deleting removes those placement(s) from the controller immediately — containers and lab data on the offline machine(s) are only cleaned up if they ever reconnect. Placements on online nodes are torn down normally, and the lab is removed once they confirm.`}
              >
                Force delete lab
              </ConfirmButton>
            </form>
          )}
          <p className="text-xs text-muted-foreground">
            Deleting tears down every placement first; storage on each node is destroyed with it.
            {offlinePlacements.length > 0 &&
              " Force delete skips waiting on the offline node(s) — use it when they are not coming back."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

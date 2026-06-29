import { notFound } from "next/navigation";
import { ConfirmButton } from "../../_components/ConfirmButton";
import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { fmtBytes, pct } from "@/lib/format";
import { containerOptionsOf, getLab } from "@/lib/labs";
import { listMembers } from "@/lib/students";
import { TIB } from "@/lib/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addMemberAction,
  destroyLabAction,
  recreateContainerAction,
  removeMemberAction,
  setQuotaAction,
  updateLabSettingsAction,
} from "../actions";

export const dynamic = "force-dynamic";

function samples(labId: number, pool: string) {
  return (db()
    .prepare(
      `SELECT used_bytes, quota_bytes, ts FROM storage_samples
       WHERE lab_id = ? AND student_id IS NULL AND pool = ? ORDER BY ts ASC LIMIT 500`,
    )
    .all(labId, pool) as { used_bytes: number; quota_bytes: number | null; ts: number }[]);
}

/** Latest docker writable-layer usage (installed software) per student, from labquota telemetry. */
function dockerByStudent(labId: number): Map<string, number> {
  const rows = db()
    .prepare(
      `SELECT students.username AS username, s.used_bytes AS used
       FROM storage_samples s JOIN students ON students.id = s.student_id
       WHERE s.lab_id = ? AND s.pool = 'docker' AND s.student_id IS NOT NULL
         AND s.ts = (SELECT MAX(ts) FROM storage_samples s2
                      WHERE s2.student_id = s.student_id AND s2.pool = 'docker')
       GROUP BY students.id`,
    )
    .all(labId) as { username: string; used: number }[];
  return new Map(rows.map((r) => [r.username, r.used]));
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-sm text-muted-foreground">not enough history</span>;
  const w = 240;
  const h = 40;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block h-10 w-full max-w-[240px]">
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="2" />
    </svg>
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
  // The cleartext password is fetched once from the server-side flash store, never the URL (M-07).
  const pw = pwid ? takeFlash(pwid) : null;
  const labId = Number(id);
  const lab = getLab(labId);
  if (!lab) notFound();
  const opts = containerOptionsOf(lab);
  const members = listMembers(labId);
  const dockerUsed = dockerByStudent(labId);

  const fast = samples(labId, "fast");
  const slow = samples(labId, "slow");
  const fastNow = fast.at(-1);
  const slowNow = slow.at(-1);

  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Lab: {lab.name}
        <Badge variant={lab.online ? "ok" : "err"}>{lab.online ? "online" : "offline"}</Badge>
      </h1>

      {savedMsg && (
        <Card className="border-primary/50">
          <CardContent>
            <p className="text-sm text-primary">{savedMsg}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <p className="text-sm">
            Node <b>{lab.node_name}</b> · PI {lab.pi_email ?? "—"} · image {lab.image} · SSH port{" "}
            {lab.ssh_port ?? "—"} · status {lab.status}
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-2">
            <h3 className="text-base font-semibold">Fast pool</h3>
            <p className="text-sm">
              {fmtBytes(fastNow?.used_bytes ?? 0)} / {fmtBytes(lab.fast_quota_bytes)}
              {fastNow && pct(fastNow.used_bytes, lab.fast_quota_bytes) !== null
                ? ` · ${pct(fastNow.used_bytes, lab.fast_quota_bytes)}%`
                : ""}
            </p>
            <Sparkline values={fast.map((s) => s.used_bytes)} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2">
            <h3 className="text-base font-semibold">Slow pool</h3>
            <p className="text-sm">
              {fmtBytes(slowNow?.used_bytes ?? 0)} / {fmtBytes(lab.slow_quota_bytes)}
            </p>
            <Sparkline values={slow.map((s) => s.used_bytes)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Quota (applies live)</h3>
          <form action={setQuotaAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="labId" value={lab.id} />
            <div>
              <Label>Fast (TB)</Label>
              <Input name="fastTb" type="number" step="0.5" defaultValue={lab.fast_quota_bytes / TIB} className="w-32" />
            </div>
            <div>
              <Label>Slow (TB)</Label>
              <Input name="slowTb" type="number" step="0.5" defaultValue={lab.slow_quota_bytes / TIB} className="w-32" />
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Lab settings</h3>
            <p className="text-xs text-muted-foreground">
              PI email is metadata. Changing the image or any container option recreates the container
              (student data on the fast/slow pools is preserved). The node and SSH port can&apos;t change.
            </p>
          </div>
          <form action={updateLabSettingsAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input type="hidden" name="labId" value={lab.id} />
            <div>
              <Label>PI email</Label>
              <Input name="piEmail" type="email" defaultValue={lab.pi_email ?? ""} placeholder="pi@uga.edu" />
            </div>
            <div>
              <Label>Base image</Label>
              <Input name="image" defaultValue={lab.image} />
            </div>
            <div className="hidden lg:block" />
            <div>
              <Label>CPUs</Label>
              <Input name="cpus" defaultValue={opts.cpus} />
            </div>
            <div>
              <Label>RAM</Label>
              <Input name="memory" defaultValue={opts.memory} />
            </div>
            <div>
              <Label>Shared memory</Label>
              <Input name="shmSize" defaultValue={opts.shm_size} />
            </div>
            <div>
              <Label>Image size quota</Label>
              <Input name="imageQuota" defaultValue={opts.image_quota} />
            </div>
            <div>
              <Label>Restart policy</Label>
              <Input name="restart" defaultValue={opts.restart} />
            </div>
            <div className="flex items-end">
              <Button type="submit">Save settings</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Members</h3>
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
                  <TableHead>Installed (container)</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.member_id}>
                    <TableCell>{m.username}</TableCell>
                    <TableCell>{m.email ?? "—"}</TableCell>
                    <TableCell>{m.name ?? "—"}</TableCell>
                    <TableCell>{dockerUsed.has(m.username) ? fmtBytes(dockerUsed.get(m.username)!) : "—"}</TableCell>
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
                          confirm={`Remove ${m.username} from ${lab.name}? If "delete data" is checked, their files are permanently erased.`}
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
        <CardContent className="flex flex-wrap gap-3">
          <form action={recreateContainerAction}>
            <input type="hidden" name="labId" value={lab.id} />
            <Button type="submit" variant="secondary">
              Recreate container
            </Button>
          </form>
          <form action={destroyLabAction}>
            <input type="hidden" name="labId" value={lab.id} />
            <ConfirmButton
              variant="destructive"
              confirm={`Destroy lab "${lab.name}"? This removes the container and ALL data (shared + every student), and deletes students that belong only to this lab. This cannot be undone.`}
            >
              Destroy lab + data
            </ConfirmButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

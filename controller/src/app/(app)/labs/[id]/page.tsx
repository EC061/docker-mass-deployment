import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { ago, fmtBytes, pct } from "@/lib/format";
import { getLab } from "@/lib/labs";
import { listMembers } from "@/lib/students";
import { TIB } from "@/lib/settings";
import {
  addMemberAction,
  destroyLabAction,
  recreateContainerAction,
  removeMemberAction,
  rescanAction,
  setQuotaAction,
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

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="muted">not enough history</span>;
  const w = 240;
  const h = 40;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}

export default async function LabDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ newuser?: string; pwid?: string; emailed?: string }>;
}) {
  const { id } = await params;
  const { newuser, pwid, emailed } = await searchParams;
  // The cleartext password is fetched once from the server-side flash store, never the URL (M-07).
  const pw = pwid ? takeFlash(pwid) : null;
  const labId = Number(id);
  const lab = getLab(labId);
  if (!lab) notFound();
  const members = listMembers(labId);

  const fast = samples(labId, "fast");
  const slow = samples(labId, "slow");
  const fastNow = fast.at(-1);
  const slowNow = slow.at(-1);

  const scans = db()
    .prepare(
      `SELECT oldfile_scans.*, students.username AS username FROM oldfile_scans
       LEFT JOIN students ON students.id = oldfile_scans.student_id
       WHERE oldfile_scans.lab_id = ? ORDER BY oldfile_scans.id`,
    )
    .all(labId) as any[];
  const lastScan = scans[0]?.scanned_at;

  return (
    <>
      <h2>
        Lab: {lab.name}{" "}
        <span className={`badge ${lab.online ? "online" : "offline"}`}>
          {lab.online ? "online" : "offline"}
        </span>
      </h2>

      <div className="card">
        <p style={{ margin: 0 }}>
          Node <b>{lab.node_name}</b> · PI {lab.pi_email ?? "—"} · image {lab.image} · SSH port{" "}
          {lab.ssh_port ?? "—"} · status {lab.status}
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          <h3 style={{ marginTop: 0 }}>Fast pool</h3>
          <p>
            {fmtBytes(fastNow?.used_bytes ?? 0)} / {fmtBytes(lab.fast_quota_bytes)}
            {fastNow && pct(fastNow.used_bytes, lab.fast_quota_bytes) !== null
              ? ` · ${pct(fastNow.used_bytes, lab.fast_quota_bytes)}%`
              : ""}
          </p>
          <Sparkline values={fast.map((s) => s.used_bytes)} />
        </div>
        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          <h3 style={{ marginTop: 0 }}>Slow pool</h3>
          <p>
            {fmtBytes(slowNow?.used_bytes ?? 0)} / {fmtBytes(lab.slow_quota_bytes)}
          </p>
          <Sparkline values={slow.map((s) => s.used_bytes)} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Quota (applies live)</h3>
        <form action={setQuotaAction} style={{ display: "flex", gap: 12, alignItems: "end" }}>
          <input type="hidden" name="labId" value={lab.id} />
          <div>
            <label>Fast (TB)</label>
            <input name="fastTb" type="number" step="0.5" defaultValue={lab.fast_quota_bytes / TIB} />
          </div>
          <div>
            <label>Slow (TB)</label>
            <input name="slowTb" type="number" step="0.5" defaultValue={lab.slow_quota_bytes / TIB} />
          </div>
          <button type="submit" style={{ width: 140, marginTop: 0 }}>
            Apply
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Members</h3>
        {newuser && pw && (
          <div
            style={{
              background: "var(--panel-2)",
              border: "1px solid var(--accent)",
              borderRadius: 7,
              padding: "10px 12px",
              marginBottom: 12,
            }}
          >
            Added <b>{newuser}</b> — password <code>{pw}</code>{" "}
            <span className="muted">
              (shown once{emailed ? "; also emailed" : "; SMTP not configured, not emailed"})
            </span>
          </div>
        )}
        <form action={addMemberAction} style={{ display: "flex", gap: 10, alignItems: "end", marginBottom: 14, flexWrap: "wrap" }}>
          <input type="hidden" name="labId" value={lab.id} />
          <div>
            <label>Username</label>
            <input name="username" required placeholder="alice" />
          </div>
          <div>
            <label>Email</label>
            <input name="email" type="email" placeholder="alice@uga.edu" />
          </div>
          <div>
            <label>Name</label>
            <input name="name" placeholder="Alice A." />
          </div>
          <button type="submit" style={{ width: 130, marginTop: 0 }}>
            Add student
          </button>
        </form>
        {members.length === 0 ? (
          <p className="muted">No students yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Name</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id}>
                  <td>{m.username}</td>
                  <td>{m.email ?? "—"}</td>
                  <td>{m.name ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeMemberAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <input type="hidden" name="labId" value={lab.id} />
                      <input type="hidden" name="studentId" value={m.id} />
                      <label className="muted" style={{ margin: 0, display: "inline-flex", gap: 4, alignItems: "center" }}>
                        <input type="checkbox" name="deleteData" style={{ width: "auto" }} /> delete data
                      </label>
                      <button type="submit" style={{ width: "auto", marginTop: 0, padding: "6px 10px", background: "var(--panel-2)" }}>
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Old files</h3>
        <form action={rescanAction} style={{ marginBottom: 12 }}>
          <input type="hidden" name="labId" value={lab.id} />
          <button type="submit" style={{ width: 140, marginTop: 0 }}>
            Rescan now
          </button>
          <span className="muted" style={{ marginLeft: 12 }}>
            {lastScan ? `scanned ${ago(lastScan)}` : "never scanned"}
          </span>
        </form>
        {scans.length === 0 ? (
          <p className="muted">No scan results yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Old by atime</th>
                <th>Old by mtime</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => (
                <tr key={s.id}>
                  <td>{s.username ?? "lab"}</td>
                  <td>
                    {s.atime_count} files · {fmtBytes(s.atime_bytes)}
                  </td>
                  <td>
                    {s.mtime_count} files · {fmtBytes(s.mtime_bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ display: "flex", gap: 12 }}>
        <form action={recreateContainerAction}>
          <input type="hidden" name="labId" value={lab.id} />
          <button type="submit" style={{ width: 200, marginTop: 0, background: "var(--panel-2)" }}>
            Recreate container
          </button>
        </form>
        <form action={destroyLabAction}>
          <input type="hidden" name="labId" value={lab.id} />
          <button type="submit" style={{ width: 200, marginTop: 0, background: "var(--err)" }}>
            Destroy lab + data
          </button>
        </form>
      </div>
    </>
  );
}

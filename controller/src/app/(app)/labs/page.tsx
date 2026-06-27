import { db } from "@/lib/db";
import { fmtBytes, pct } from "@/lib/format";
import { listLabs } from "@/lib/labs";
import { getSettings, TIB } from "@/lib/settings";
import { createLabAction } from "./actions";

export const dynamic = "force-dynamic";

interface NodeOpt {
  id: number;
  name: string;
  online: number;
}

function latestUsage(labId: number, pool: string): { used: number; quota: number | null } | null {
  const row = db()
    .prepare(
      `SELECT used_bytes, quota_bytes FROM storage_samples
       WHERE lab_id = ? AND student_id IS NULL AND pool = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(labId, pool) as { used_bytes: number; quota_bytes: number | null } | undefined;
  return row ? { used: row.used_bytes, quota: row.quota_bytes } : null;
}

export default function LabsPage() {
  const labs = listLabs();
  const nodes = db().prepare("SELECT id, name, online FROM nodes ORDER BY name").all() as NodeOpt[];
  const settings = getSettings();

  return (
    <>
      <h2>Labs</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Create lab</h3>
        {nodes.length === 0 ? (
          <p className="muted">Connect a node first — a lab is pinned to one node.</p>
        ) : (
          <form action={createLabAction} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            <div>
              <label>Name</label>
              <input name="name" required placeholder="bio-x" />
            </div>
            <div>
              <label>Node</label>
              <select name="nodeId" required defaultValue="">
                <option value="" disabled>
                  Select node…
                </option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} {n.online ? "(online)" : "(offline)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>PI email</label>
              <input name="piEmail" type="email" placeholder="pi@uga.edu" />
            </div>
            <div>
              <label>Base image</label>
              <input name="image" defaultValue="custom-ssh" />
            </div>
            <div>
              <label>Fast quota (TB)</label>
              <input name="fastTb" type="number" step="0.5" defaultValue={settings.fastQuotaDefaultBytes / TIB} />
            </div>
            <div>
              <label>Slow quota (TB)</label>
              <input name="slowTb" type="number" step="0.5" defaultValue={settings.slowQuotaDefaultBytes / TIB} />
            </div>
            <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                Container options below are set once at creation; changing them later requires
                &ldquo;recreate container&rdquo; (data is preserved). All GPUs are always attached.
              </span>
            </div>
            <div>
              <label>CPUs</label>
              <input name="cpus" defaultValue="4" />
            </div>
            <div>
              <label>RAM</label>
              <input name="memory" defaultValue="8g" />
            </div>
            <div>
              <label>Shared memory</label>
              <input name="shmSize" defaultValue="1g" />
            </div>
            <div>
              <label>Image size quota</label>
              <input name="imageQuota" defaultValue="300g" />
            </div>
            <div>
              <label>Restart policy</label>
              <input name="restart" defaultValue="unless-stopped" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <button type="submit" style={{ width: 160 }}>
                Create lab
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {labs.length === 0 ? (
          <p className="muted">No labs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Lab</th>
                <th>Node</th>
                <th>Fast</th>
                <th>Slow</th>
                <th>SSH</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {labs.map((lab) => {
                const fast = latestUsage(lab.id, "fast");
                const slow = latestUsage(lab.id, "slow");
                return (
                  <tr key={lab.id}>
                    <td>
                      <a href={`/labs/${lab.id}`}>{lab.name}</a>
                    </td>
                    <td>
                      {lab.node_name}{" "}
                      <span className={`badge ${lab.online ? "online" : "offline"}`}>
                        {lab.online ? "online" : "offline"}
                      </span>
                    </td>
                    <td>
                      {fmtBytes(fast?.used ?? 0)} / {fmtBytes(lab.fast_quota_bytes)}
                      {fast && pct(fast.used, lab.fast_quota_bytes) !== null
                        ? ` (${pct(fast.used, lab.fast_quota_bytes)}%)`
                        : ""}
                    </td>
                    <td>
                      {fmtBytes(slow?.used ?? 0)} / {fmtBytes(lab.slow_quota_bytes)}
                    </td>
                    <td>{lab.ssh_port ?? "—"}</td>
                    <td>{lab.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

import { db } from "@/lib/db";
import { takeFlash } from "@/lib/flash";
import { fmtBytes, pct } from "@/lib/format";
import { containerOptionsOf, listLabs } from "@/lib/labs";
import { getSettings, TIB } from "@/lib/settings";
import { createLabAction } from "./actions";
import { CreateLabForm, type LabTemplate, type NodeOpt } from "./_components/CreateLabForm";

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
    <>
      <h2>Labs</h2>

      {importedMsg && (
        <div className="card" style={{ borderColor: "var(--accent)", marginBottom: 16 }}>
          <p style={{ margin: 0, color: "var(--accent)" }}>{importedMsg}</p>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Create lab</h3>
        {nodes.length === 0 ? (
          <p className="muted">Connect a node first — a lab is pinned to one node.</p>
        ) : (
          <CreateLabForm
            nodes={nodes}
            labs={templates}
            defaultFastTb={settings.fastQuotaDefaultBytes / TIB}
            defaultSlowTb={settings.slowQuotaDefaultBytes / TIB}
            action={createLabAction}
          />
        )}
      </div>

      <div className="card">
        {labs.length === 0 ? (
          <p className="muted">No labs yet.</p>
        ) : (
          <div className="table-wrap">
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
          </div>
        )}
      </div>
    </>
  );
}

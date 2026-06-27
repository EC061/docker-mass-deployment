import { db } from "@/lib/db";
import { ago, fmtBytes } from "@/lib/format";

export const dynamic = "force-dynamic";

interface SnapRow {
  node: string;
  pid: number;
  user: string | null;
  lab: string | null;
  vram_bytes: number | null;
  util: number | null;
  ts: number;
}

interface EventRow {
  node: string;
  pid: number | null;
  user: string | null;
  lab: string | null;
  state: string;
  ts: number;
}

export default function GpuPage() {
  const snapshot = db()
    .prepare("SELECT * FROM gpu_snapshot ORDER BY node, vram_bytes DESC")
    .all() as SnapRow[];
  const events = db()
    .prepare("SELECT * FROM gpu_events ORDER BY ts DESC LIMIT 100")
    .all() as EventRow[];

  return (
    <>
      <h2>GPU</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Live processes</h3>
        {snapshot.length === 0 ? (
          <p className="muted">No GPU processes reported.</p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>PID</th>
                <th>User</th>
                <th>Lab</th>
                <th>VRAM</th>
                <th>Util %</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.map((r) => (
                <tr key={`${r.node}-${r.pid}`}>
                  <td>{r.node}</td>
                  <td>{r.pid}</td>
                  <td>{r.user ?? "—"}</td>
                  <td>{r.lab ?? "—"}</td>
                  <td>{fmtBytes(r.vram_bytes)}</td>
                  <td style={{ color: (r.util ?? 0) <= 5 ? "var(--warn)" : "var(--text)" }}>
                    {r.util ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent idle-kill events</h3>
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Node</th>
                <th>PID</th>
                <th>User</th>
                <th>Lab</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="muted">{ago(e.ts)}</td>
                  <td>{e.node}</td>
                  <td>{e.pid ?? "—"}</td>
                  <td>{e.user ?? "—"}</td>
                  <td>{e.lab ?? "—"}</td>
                  <td style={{ color: e.state === "killed" ? "var(--err)" : "var(--warn)" }}>
                    {e.state}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </>
  );
}

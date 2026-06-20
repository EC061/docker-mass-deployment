import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface NodeRow {
  name: string;
  online: number;
  last_seen: number | null;
  capabilities: string | null;
  pools: string | null;
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

export default function NodesPage() {
  const nodes = db()
    .prepare("SELECT name, online, last_seen, capabilities, pools FROM nodes ORDER BY name")
    .all() as NodeRow[];

  return (
    <>
      <h2>Nodes</h2>
      <div className="card">
        {nodes.length === 0 ? (
          <p className="muted">No nodes have connected yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Status</th>
                <th>GPUs</th>
                <th>Pools</th>
                <th>Issues</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const caps = n.capabilities ? JSON.parse(n.capabilities) : {};
                const pools = n.pools ? JSON.parse(n.pools) : [];
                return (
                  <tr key={n.name}>
                    <td>{n.name}</td>
                    <td>
                      <span className={`badge ${n.online ? "online" : "offline"}`}>
                        {n.online ? "online" : "offline"}
                      </span>
                    </td>
                    <td>{caps.gpu_count ?? 0}</td>
                    <td>
                      {pools.length === 0
                        ? "—"
                        : pools.map((p: any) => `${p.name}: ${fmtBytes(p.free)} free`).join(", ")}
                    </td>
                    <td>
                      {caps.issues && caps.issues.length > 0 ? (
                        <span style={{ color: "var(--warn)" }}>{caps.issues.length}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="muted">{ago(n.last_seen)}</td>
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

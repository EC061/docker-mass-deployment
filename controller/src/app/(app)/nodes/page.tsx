import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface NodeRow {
  name: string;
  online: number;
  last_seen: number | null;
  capabilities: string | null;
  pools: string | null;
  scrub_status: string | null;
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

export default function NodesPage() {
  const nodes = db()
    .prepare("SELECT name, online, last_seen, capabilities, pools, scrub_status FROM nodes ORDER BY name")
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
                <th>Cold storage</th>
                <th>Scrub</th>
                <th>Issues</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const caps = n.capabilities ? JSON.parse(n.capabilities) : {};
                const pools = n.pools ? JSON.parse(n.pools) : [];
                const scrub = scrubSummary(n.scrub_status);
                const coldText =
                  caps.slow_backend === "smb"
                    ? `SMB${caps.slow_shared ? " (shared)" : ""}`
                    : "ZFS";
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
                    <td>{coldText}</td>
                    <td style={scrub.bad ? { color: "var(--warn)" } : undefined}>{scrub.text}</td>
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

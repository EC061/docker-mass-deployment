import { db } from "@/lib/db";
import { ConfirmButton } from "../_components/ConfirmButton";
import {
  deleteNodeAction,
  provisionNodeAction,
  revokeNodeAction,
  rotateNodeTokenAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface NodeRow {
  name: string;
  online: number;
  last_seen: number | null;
  capabilities: string | null;
  pools: string | null;
  scrub_status: string | null;
  allowed: number;
  auth_mode: string;
  token_pinned_at: number | null;
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
  if (n.allowed !== 1) return "revoked";
  if (n.auth_mode === "pernode") return n.token_pinned_at ? "per-node" : "per-node (pending)";
  return "legacy token";
}

export default async function NodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const provisioned = typeof sp.provisioned === "string" ? sp.provisioned : undefined;
  const token = typeof sp.token === "string" ? sp.token : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const deleted = typeof sp.deleted === "string" ? sp.deleted : undefined;

  const nodes = db()
    .prepare(
      "SELECT name, online, last_seen, capabilities, pools, scrub_status, allowed, auth_mode, token_pinned_at FROM nodes ORDER BY name",
    )
    .all() as NodeRow[];

  return (
    <>
      <h2>Nodes</h2>

      {error && (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 16 }}>
          <p style={{ color: "var(--warn)" }}>{error}</p>
        </div>
      )}

      {deleted && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted">Node “{deleted}” was deleted.</p>
        </div>
      )}

      {provisioned && token && (
        <div className="card" style={{ borderColor: "var(--accent, #5fa0c2)", marginBottom: 16 }}>
          <h3>Token for node “{provisioned}”</h3>
          <p className="muted">Shown once. Run this on the node, then the agent reconnects automatically:</p>
          <pre style={{ overflowX: "auto", padding: 12, background: "var(--panel-2)" }}>
            <code>sudo lab-agent set-token {token}</code>
          </pre>
          <p className="muted" style={{ fontSize: 12 }}>
            (Equivalent to writing the token into <code>/etc/lab-agent/config.toml</code> and running
            <code> systemctl restart lab-agent</code>.)
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Register a node</h3>
        <form action={provisionNodeAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input name="name" placeholder="node name (e.g. gpu-01)" required pattern="[a-z0-9][a-z0-9\-]{0,62}" />
          <button type="submit">Provision token</button>
        </form>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Adds the node to the allow-list and issues a per-node token. Only allow-listed nodes may connect.
        </p>
      </div>

      <div className="card">
        {nodes.length === 0 ? (
          <p className="muted">No nodes have connected yet.</p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Status</th>
                <th>Auth</th>
                <th>GPUs</th>
                <th>Pools</th>
                <th>Cold storage</th>
                <th>Scrub</th>
                <th>Issues</th>
                <th>Last seen</th>
                <th>Token</th>
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
                    <td style={n.allowed !== 1 ? { color: "var(--warn)" } : undefined}>{authLabel(n)}</td>
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
                    <td style={{ whiteSpace: "nowrap" }}>
                      <form action={rotateNodeTokenAction} style={{ display: "inline" }}>
                        <input type="hidden" name="name" value={n.name} />
                        <button type="submit" className="secondary" style={{ width: "auto", padding: "6px 12px" }}>
                          Rotate
                        </button>
                      </form>{" "}
                      {n.allowed === 1 && (
                        <form action={revokeNodeAction} style={{ display: "inline" }}>
                          <input type="hidden" name="name" value={n.name} />
                          <button
                            type="submit"
                            className="secondary"
                            style={{ width: "auto", padding: "6px 12px", color: "var(--warn)" }}
                          >
                            Revoke
                          </button>
                        </form>
                      )}{" "}
                      <form action={deleteNodeAction} style={{ display: "inline" }}>
                        <input type="hidden" name="name" value={n.name} />
                        <ConfirmButton
                          type="submit"
                          className="secondary"
                          style={{ width: "auto", padding: "6px 12px", color: "var(--warn)" }}
                          confirm={`Delete node "${n.name}"? This removes it from the controller (it fails if any labs are still pinned to it).`}
                        >
                          Delete
                        </ConfirmButton>
                      </form>
                    </td>
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

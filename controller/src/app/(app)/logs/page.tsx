import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface LogRow {
  ts: number;
  node: string | null;
  level: string;
  source: string | null;
  msg: string;
}

export default function LogsPage() {
  const logs = db()
    .prepare("SELECT ts, node, level, source, msg FROM logs ORDER BY ts DESC LIMIT 200")
    .all() as LogRow[];

  return (
    <>
      <h2>Logs</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Filtering, live tail, and log-level admin alerts land in phase 5. Showing the latest 200 lines.
        </p>
        {logs.length === 0 ? (
          <p className="muted">No logs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Node</th>
                <th>Level</th>
                <th>Source</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td className="muted">{new Date(l.ts).toLocaleString()}</td>
                  <td>{l.node ?? "—"}</td>
                  <td>{l.level}</td>
                  <td>{l.source ?? "—"}</td>
                  <td>{l.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

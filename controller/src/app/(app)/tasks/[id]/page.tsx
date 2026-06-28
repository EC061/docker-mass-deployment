import { db } from "@/lib/db";
import { ago } from "@/lib/format";
import { getTask } from "@/lib/queue";

export const dynamic = "force-dynamic";

interface LogRow {
  ts: number;
  node: string | null;
  level: string;
  source: string | null;
  lab: string | null;
  user: string | null;
  msg: string;
  detail: string | null;
}

/** Pretty-print a JSON string column; fall back to the raw text if it isn't valid JSON. */
function prettyJson(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const STATE_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  failed: "var(--err)",
  queued: "var(--muted)",
  sent: "var(--warn)",
};

function fullTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const preStyle: React.CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  padding: 12,
  overflow: "auto",
  fontSize: 13,
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);

  if (!task) {
    return (
      <>
        <h2>Task</h2>
        <div className="card">
          <p className="muted">No task found with id {id}.</p>
          <p>
            <a href="/logs">← Back to logs</a>
          </p>
        </div>
      </>
    );
  }

  const logs = db()
    .prepare("SELECT * FROM logs WHERE task_id = ? ORDER BY ts ASC")
    .all(id) as LogRow[];

  const params2 = prettyJson(task.params);
  const result = prettyJson(task.result);
  const durationMs = task.updated_at - task.created_at;
  const color = (lvl: string) =>
    lvl === "ERROR" ? "var(--err)" : lvl === "WARN" ? "var(--warn)" : "var(--muted)";

  const meta: [string, React.ReactNode][] = [
    ["Action", <code key="a">{task.action}</code>],
    ["State", <span key="s" style={{ color: STATE_COLOR[task.state] ?? "var(--text)", fontWeight: 600 }}>{task.state}</span>],
    ["Node", task.node],
    ["Requested by", task.requested_by ?? "—"],
    ["Task ID", <code key="id" style={{ fontSize: 12 }}>{task.task_uuid}</code>],
    ["Queue job", task.job_id ?? "—"],
    ["Created", `${fullTime(task.created_at)} (${ago(task.created_at)})`],
    ["Updated", `${fullTime(task.updated_at)} (${ago(task.updated_at)})`],
    ["Duration", durationMs >= 0 ? `${(durationMs / 1000).toFixed(1)}s` : "—"],
  ];

  return (
    <>
      <h2>
        Task: <code>{task.action}</code>{" "}
        <span style={{ color: STATE_COLOR[task.state] ?? "var(--text)", fontSize: 16 }}>{task.state}</span>
      </h2>
      <p>
        <a href="/logs">← Back to logs</a> ·{" "}
        <a href={`/logs?task=${encodeURIComponent(task.task_uuid)}`}>filter logs to this task</a>
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Overview</h3>
        <table>
          <tbody>
            {meta.map(([k, v]) => (
              <tr key={k}>
                <td className="muted" style={{ width: 140, verticalAlign: "top" }}>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {task.error && (
        <div className="card">
          <h3 style={{ marginTop: 0, color: "var(--err)" }}>Error</h3>
          <pre style={{ ...preStyle, color: "var(--err)" }}>{task.error}</pre>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Parameters</h3>
        {params2 ? <pre style={preStyle}>{params2}</pre> : <p className="muted">No parameters.</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Result</h3>
        {result ? (
          <pre style={preStyle}>{result}</pre>
        ) : (
          <p className="muted">
            {task.state === "ok" ? "Completed with no result payload." : "No result yet."}
          </p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Log entries ({logs.length})</h3>
        {logs.length === 0 ? (
          <p className="muted">No log entries reference this task.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l, i) => (
                  <tr key={i}>
                    <td className="muted" title={fullTime(l.ts)}>{ago(l.ts)}</td>
                    <td style={{ color: color(l.level), fontWeight: 600 }}>{l.level}</td>
                    <td>{l.source ?? "—"}</td>
                    <td>
                      {l.msg}
                      {l.detail && (
                        <details style={{ marginTop: 4 }}>
                          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>detail</summary>
                          <pre style={{ ...preStyle, marginTop: 4 }}>{l.detail}</pre>
                        </details>
                      )}
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

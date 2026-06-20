import { db } from "@/lib/db";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

interface LogRow {
  ts: number;
  node: string | null;
  level: string;
  source: string | null;
  lab: string | null;
  user: string | null;
  task_id: string | null;
  msg: string;
  detail: string | null;
}

const LEVELS = ["", "DEBUG", "INFO", "WARN", "ERROR"];

export default function LogsPage({
  searchParams,
}: {
  searchParams: { level?: string; node?: string; q?: string; task?: string };
}) {
  const { level = "", node = "", q = "", task = "" } = searchParams;

  const where: string[] = [];
  const args: unknown[] = [];
  if (level) {
    where.push("level = ?");
    args.push(level);
  }
  if (node) {
    where.push("node = ?");
    args.push(node);
  }
  if (task) {
    where.push("task_id = ?");
    args.push(task);
  }
  if (q) {
    where.push("(msg LIKE ? OR detail LIKE ? OR source LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const logs = db()
    .prepare(`SELECT * FROM logs ${clause} ORDER BY ts DESC LIMIT 300`)
    .all(...args) as LogRow[];

  const nodes = (db().prepare("SELECT DISTINCT node FROM logs WHERE node IS NOT NULL").all() as {
    node: string;
  }[]).map((r) => r.node);

  const color = (lvl: string) =>
    lvl === "ERROR" ? "var(--err)" : lvl === "WARN" ? "var(--warn)" : "var(--muted)";

  return (
    <>
      <h2>Logs</h2>
      <div className="card">
        <form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <div>
            <label>Level</label>
            <select name="level" defaultValue={level}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l || "all"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Node</label>
            <select name="node" defaultValue={node}>
              <option value="">all</option>
              {nodes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Search</label>
            <input name="q" defaultValue={q} placeholder="message / source" />
          </div>
          {task && <input type="hidden" name="task" value={task} />}
          <button type="submit" style={{ width: 110, marginTop: 0 }}>
            Filter
          </button>
          {(level || node || q || task) && (
            <a href="/logs" style={{ marginBottom: 9 }}>
              clear
            </a>
          )}
        </form>
        {task && <p className="muted">Filtered to task {task}</p>}
      </div>

      <div className="card">
        {logs.length === 0 ? (
          <p className="muted">No matching logs.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Node</th>
                <th>Source</th>
                <th>Message</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td className="muted" title={new Date(l.ts).toISOString()}>
                    {ago(l.ts)}
                  </td>
                  <td style={{ color: color(l.level), fontWeight: 600 }}>{l.level}</td>
                  <td>{l.node ?? "—"}</td>
                  <td>{l.source ?? "—"}</td>
                  <td>{l.msg}</td>
                  <td>
                    {l.task_id ? (
                      <a href={`/logs?task=${encodeURIComponent(l.task_id)}`} title={l.task_id}>
                        {l.task_id.slice(0, 8)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

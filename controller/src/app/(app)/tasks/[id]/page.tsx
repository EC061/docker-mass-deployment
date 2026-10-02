import { ago } from "@/lib/format";
import { listLogs } from "@/lib/logs";
import { getTask, redactSecrets } from "@/lib/queue";
import { describeTask } from "@/lib/task-description";
import { LogTable } from "@/components/log-table";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * Pretty-print a JSON string column with credentials masked; fall back to raw text if not JSON.
 * Params are already redacted at store time (Phase 8); this also covers pre-Phase-8 rows and any
 * secret a result payload might echo, so no password is ever rendered.
 */
function prettyJson(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(redactSecrets(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}

const STATE_COLOR: Record<string, string> = {
  ok: "text-ok",
  failed: "text-err",
  queued: "text-muted-foreground",
  sent: "text-warn",
};

function fullTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const PRE_CLASS =
  "m-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-[13px]";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);

  if (!task) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Task</h1>
        <Card>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">No task found with id {id}.</p>
            <p>
              <a href="/logs" className="text-primary hover:underline">
                ← Back to logs
              </a>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const logs = listLogs({ task: id }, { chronological: true, limit: -1 });

  const params2 = prettyJson(task.params);
  const result = prettyJson(task.result);
  const durationMs = task.updated_at - task.created_at;

  const meta: [string, React.ReactNode][] = [
    ["Description", describeTask(task.action, task.params)],
    ["Action", <code key="a">{task.action}</code>],
    [
      "State",
      <span key="s" className={`font-semibold ${STATE_COLOR[task.state] ?? ""}`}>
        {task.state}
      </span>,
    ],
    ["Node", task.node],
    ["Requested by", task.requested_by ?? "—"],
    ["Task ID", <code key="id" className="text-xs">{task.task_uuid}</code>],
    ["Queue job", task.job_id ?? "—"],
    ["Created", `${fullTime(task.created_at)} (${ago(task.created_at)})`],
    ["Updated", `${fullTime(task.updated_at)} (${ago(task.updated_at)})`],
    ["Duration", durationMs >= 0 ? `${(durationMs / 1000).toFixed(1)}s` : "—"],
  ];

  return (
    <div className="space-y-4">
      <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
        {describeTask(task.action, task.params)} on {task.node}
        <span className={`text-base ${STATE_COLOR[task.state] ?? ""}`}>{task.state}</span>
      </h1>
      <p className="text-sm">
        <a href="/logs" className="text-primary hover:underline">
          ← Back to logs
        </a>{" "}
        ·{" "}
        <a href={`/logs?task=${encodeURIComponent(task.task_uuid)}`} className="text-primary hover:underline">
          filter logs to this task
        </a>
      </p>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Overview</h2>
          <table className="text-sm">
            <tbody>
              {meta.map(([k, v]) => (
                <tr key={k as string}>
                  <td className="w-36 py-1 align-top text-muted-foreground">{k}</td>
                  <td className="py-1">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {task.error && (
        <Card>
          <CardContent className="space-y-3">
            <h2 className="text-base font-semibold text-err">Error</h2>
            <pre className={`${PRE_CLASS} text-err`}>{task.error}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Parameters</h2>
          {params2 ? <pre className={PRE_CLASS}>{params2}</pre> : <p className="text-sm text-muted-foreground">No parameters.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Result</h2>
          {result ? (
            <pre className={PRE_CLASS}>{result}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {task.state === "ok" ? "Completed with no result payload." : "No result yet."}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">Log entries ({logs.length})</h2>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No log entries reference this task.</p>
          ) : (
            <LogTable logs={logs} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

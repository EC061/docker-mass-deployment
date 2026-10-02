import { ago } from "@/lib/format";
import type { LogRow } from "@/lib/logs";
import { describeTask } from "@/lib/task-description";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function LogTable({ logs }: { logs: LogRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Level</TableHead>
          <TableHead>Node</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Message</TableHead>
          <TableHead>Task</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <TableRow key={log.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(log.ts).toISOString()}>
              {ago(log.ts)}
            </TableCell>
            <TableCell className={`font-semibold ${log.level === "ERROR" ? "text-err" : log.level === "WARN" ? "text-warn" : "text-muted-foreground"}`}>
              {log.level}
            </TableCell>
            <TableCell className="whitespace-nowrap">{log.node ?? "—"}</TableCell>
            <TableCell className="min-w-52 whitespace-normal">
              {log.task_action ? (
                <>
                  <div>{describeTask(log.task_action, log.task_params)}</div>
                  <code className="text-xs text-muted-foreground">{log.task_action}</code>
                </>
              ) : "—"}
            </TableCell>
            <TableCell>{log.source ?? "—"}</TableCell>
            <TableCell className="min-w-64 max-w-2xl whitespace-normal [overflow-wrap:anywhere]">
              <div>{log.msg}</div>
              {(log.lab || log.user) && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {[log.lab && `Lab: ${log.lab}`, log.user && `Student: ${log.user}`].filter(Boolean).join(" · ")}
                </div>
              )}
              {log.detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Output / details</summary>
                  <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-xs">
                    {log.detail}
                  </pre>
                </details>
              )}
            </TableCell>
            <TableCell>
              {log.task_id ? (
                <a href={`/tasks/${encodeURIComponent(log.task_id)}`} title={log.task_id} className="text-primary hover:underline">
                  {log.task_id.slice(0, 8)}
                </a>
              ) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

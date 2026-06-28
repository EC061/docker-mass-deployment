import { db } from "@/lib/db";
import { ago } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; node?: string; q?: string; task?: string }>;
}) {
  const { level = "", node = "", q = "", task = "" } = await searchParams;

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
    lvl === "ERROR" ? "text-err" : lvl === "WARN" ? "text-warn" : "text-muted-foreground";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
      <Card>
        <CardContent className="space-y-2">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Level</Label>
              <Select name="level" defaultValue={level} className="w-32">
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l || "all"}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Node</Label>
              <Select name="node" defaultValue={node} className="w-40">
                <option value="">all</option>
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Search</Label>
              <Input name="q" defaultValue={q} placeholder="message / source" />
            </div>
            {task && <input type="hidden" name="task" value={task} />}
            <Button type="submit">Filter</Button>
            {(level || node || q || task) && (
              <a href="/logs" className="pb-2 text-sm text-primary hover:underline">
                clear
              </a>
            )}
          </form>
          {task && <p className="text-sm text-muted-foreground">Filtered to task {task}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching logs.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Node</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Task</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(l.ts).toISOString()}>
                      {ago(l.ts)}
                    </TableCell>
                    <TableCell className={`font-semibold ${color(l.level)}`}>{l.level}</TableCell>
                    <TableCell>{l.node ?? "—"}</TableCell>
                    <TableCell>{l.source ?? "—"}</TableCell>
                    <TableCell>{l.msg}</TableCell>
                    <TableCell>
                      {l.task_id ? (
                        <a
                          href={`/tasks/${encodeURIComponent(l.task_id)}`}
                          title={l.task_id}
                          className="text-primary hover:underline"
                        >
                          {l.task_id.slice(0, 8)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

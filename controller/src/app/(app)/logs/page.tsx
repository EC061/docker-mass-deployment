import { listLogs, logNodes } from "@/lib/logs";
import { LogTable } from "@/components/log-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export const dynamic = "force-dynamic";

const LEVELS = ["", "DEBUG", "INFO", "WARN", "ERROR"];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; node?: string; q?: string; task?: string }>;
}) {
  const { level = "", node = "", q = "", task = "" } = await searchParams;

  const logs = listLogs({ level, node, q, task });
  const nodes = logNodes();

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
              <Input name="q" defaultValue={q} placeholder="node / action / message" />
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
            <LogTable logs={logs} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

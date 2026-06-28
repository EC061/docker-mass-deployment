import { db } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function count(sql: string): number {
  const row = db().prepare(sql).get() as { n: number };
  return row.n;
}

export default function Dashboard() {
  const nodesTotal = count("SELECT COUNT(*) AS n FROM nodes");
  const nodesOnline = count("SELECT COUNT(*) AS n FROM nodes WHERE online = 1");
  const labs = count("SELECT COUNT(*) AS n FROM labs");
  const students = count("SELECT COUNT(*) AS n FROM students");

  const stats: [string, string | number][] = [
    ["Nodes online", `${nodesOnline} / ${nodesTotal}`],
    ["Labs", labs],
    ["Students", students],
  ];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <Card key={label}>
            <CardContent>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="mt-1.5 text-3xl font-bold tracking-tight">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Connect an agent with{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              lab-agent install --controller … --token …
            </code>
            ; it will appear on the{" "}
            <a href="/nodes" className="text-primary hover:underline">
              Nodes
            </a>{" "}
            page once it dials in.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

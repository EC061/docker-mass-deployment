import { db } from "@/lib/db";

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

  const stats = [
    ["Nodes online", `${nodesOnline} / ${nodesTotal}`],
    ["Labs", labs],
    ["Students", students],
  ];

  return (
    <>
      <h2>Dashboard</h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {stats.map(([label, value]) => (
          <div className="card" key={label} style={{ minWidth: 160 }}>
            <div className="muted" style={{ fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>{value}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <p className="muted">
          Connect an agent with <code>lab-agent install --controller … --token …</code>; it will
          appear on the <a href="/nodes">Nodes</a> page once it dials in.
        </p>
      </div>
    </>
  );
}

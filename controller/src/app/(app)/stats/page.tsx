import { fmtBytes, pct } from "@/lib/format";
import { buildStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

function quotaCell(used: number | null, quota: number | null) {
  if (used === null) return <span className="muted">—</span>;
  const p = quota ? pct(used, quota) : null;
  return (
    <>
      {fmtBytes(used)}
      {quota ? (
        <span className="muted">
          {" "}/ {fmtBytes(quota)}
          {p !== null && ` (${p}%)`}
        </span>
      ) : null}
    </>
  );
}

export default async function StatsPage() {
  const nodes = buildStats();
  const totalLabs = nodes.reduce((n, x) => n + x.labs.length, 0);

  return (
    <>
      <h2>Storage stats</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Per-student storage by node and lab. <strong>Image</strong> is a student&apos;s writable-layer
        (overlayfs) usage; <strong>Fast</strong> is scratch; <strong>Cold</strong> is cold storage.
        Fast/Cold are usually reported only at the lab level (the lab quota covers all students).
        Numbers come from the latest agent usage report.
      </p>

      {totalLabs === 0 ? (
        <div className="card">
          <p className="muted">No labs yet.</p>
        </div>
      ) : (
        nodes.map((node) => (
          <div className="card" key={node.node}>
            <h3 style={{ marginTop: 0 }}>
              {node.node}{" "}
              <span className={`badge ${node.online ? "online" : "offline"}`}>
                {node.online ? "online" : "offline"}
              </span>
              <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                {" "}· whole-image usage on this node: {fmtBytes(node.totalImageBytes)}
              </span>
            </h3>

            {node.labs.map((lab) => (
              <div key={lab.labId} style={{ marginBottom: 22 }}>
                <h4 style={{ margin: "8px 0" }}>
                  <a href={`/labs/${lab.labId}`}>{lab.labName}</a>{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    · image {lab.image} · {lab.students.length} student
                    {lab.students.length === 1 ? "" : "s"}
                  </span>
                </h4>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Image (overlay)</th>
                        <th>Fast</th>
                        <th>Cold</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lab.students.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="muted">
                            No students enrolled.
                          </td>
                        </tr>
                      ) : (
                        lab.students.map((s) => (
                          <tr key={s.studentId}>
                            <td>
                              {s.username}
                              {s.name && (
                                <span className="muted" style={{ fontSize: 12 }}>
                                  {" "}· {s.name}
                                </span>
                              )}
                            </td>
                            <td>{s.docker === null ? <span className="muted">—</span> : fmtBytes(s.docker)}</td>
                            <td>{s.fast === null ? <span className="muted">—</span> : fmtBytes(s.fast)}</td>
                            <td>{s.slow === null ? <span className="muted">—</span> : fmtBytes(s.slow)}</td>
                          </tr>
                        ))
                      )}
                      <tr style={{ fontWeight: 600, borderTop: "2px solid var(--border)" }}>
                        <td>Lab total (whole image)</td>
                        <td>{lab.aggregate.docker === null ? <span className="muted">—</span> : fmtBytes(lab.aggregate.docker)}</td>
                        <td>{quotaCell(lab.aggregate.fast.used, lab.aggregate.fast.quota)}</td>
                        <td>{quotaCell(lab.aggregate.slow.used, lab.aggregate.slow.quota)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </>
  );
}

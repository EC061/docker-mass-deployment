import { listLabs } from "@/lib/labs";
import { listStudents } from "@/lib/students";
import { importCsvAction } from "./actions";

export const dynamic = "force-dynamic";

export default function StudentsPage({
  searchParams,
}: {
  searchParams: { imported?: string; skipped?: string; error?: string };
}) {
  const students = listStudents();
  const labs = listLabs();

  return (
    <>
      <h2>Students</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Import from CSV</h3>
        {searchParams.imported && (
          <p style={{ color: "var(--ok)" }}>
            Imported {searchParams.imported}, skipped {searchParams.skipped}.
          </p>
        )}
        {searchParams.error && <p className="error">{searchParams.error}</p>}
        {labs.length === 0 ? (
          <p className="muted">Create a lab first.</p>
        ) : (
          <form action={importCsvAction}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              <div>
                <label>Target lab</label>
                <select name="labId" required defaultValue="">
                  <option value="" disabled>
                    Select lab…
                  </option>
                  {labs.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Username column</label>
                <input name="colUsername" defaultValue="username" />
              </div>
              <div>
                <label>Email column</label>
                <input name="colEmail" defaultValue="email" />
              </div>
              <div>
                <label>Name column</label>
                <input name="colName" defaultValue="name" />
              </div>
              <div>
                <label>Student ID column</label>
                <input name="colStudentId" placeholder="(optional)" />
              </div>
            </div>
            <label>CSV (paste, first row = headers)</label>
            <textarea
              name="csv"
              rows={6}
              style={{ width: "100%", fontFamily: "monospace", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: 10 }}
              placeholder={"username,email,name\nalice,alice@uga.edu,Alice A."}
            />
            <button type="submit" style={{ width: 160 }}>
              Import
            </button>
            <p className="muted" style={{ fontSize: 12 }}>
              Column names map CSV headers to fields. Rows with a missing/invalid/duplicate username
              (or missing email when an email column is given) are skipped.
            </p>
          </form>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>All students</h3>
        {students.length === 0 ? (
          <p className="muted">No students yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Name</th>
                <th>Student ID</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td>{s.username}</td>
                  <td>{s.email ?? "—"}</td>
                  <td>{s.name ?? "—"}</td>
                  <td>{s.student_id ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

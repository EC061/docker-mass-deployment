import { listLabs } from "@/lib/labs";
import { listMembers } from "@/lib/students";
import { ConfirmButton } from "../_components/ConfirmButton";
import { ImportStudentsForm } from "./_components/ImportStudentsForm";
import { importStudentsAction, removeStudentAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function StudentsPage() {
  const labs = listLabs();
  // Students are shown grouped by the lab they belong to (a student can be in more than one lab and
  // then appears under each).
  const labsWithMembers = labs.map((l) => ({ lab: l, members: listMembers(l.id) }));
  const totalMemberships = labsWithMembers.reduce((n, l) => n + l.members.length, 0);

  return (
    <>
      <h2>Students</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Import from CSV</h3>
        <ImportStudentsForm
          labs={labs.map((l) => ({ id: l.id, name: l.name }))}
          importAction={importStudentsAction}
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Students by lab</h3>
        {totalMemberships === 0 ? (
          <p className="muted">No students yet.</p>
        ) : (
          labsWithMembers
            .filter((l) => l.members.length > 0)
            .map(({ lab, members }) => (
              <div key={lab.id} style={{ marginBottom: 20 }}>
                <h4 style={{ margin: "8px 0" }}>
                  <a href={`/labs/${lab.id}`}>{lab.name}</a>{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    · {lab.node_name} · {members.length} student{members.length === 1 ? "" : "s"}
                  </span>
                </h4>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Username</th>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Student ID</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.member_id}>
                          <td>{m.username}</td>
                          <td>{m.email ?? "—"}</td>
                          <td>{m.name ?? "—"}</td>
                          <td>{m.student_id ?? "—"}</td>
                          <td style={{ textAlign: "right" }}>
                            <form action={removeStudentAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <input type="hidden" name="labId" value={lab.id} />
                              <input type="hidden" name="studentId" value={m.id} />
                              <label className="muted" style={{ margin: 0, display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <input type="checkbox" name="deleteData" style={{ width: "auto" }} /> delete data
                              </label>
                              <ConfirmButton
                                type="submit"
                                className="secondary"
                                style={{ width: "auto", marginTop: 0, padding: "6px 10px" }}
                                confirm={`Remove ${m.username} from ${lab.name}? If "delete data" is checked, their files are permanently erased.`}
                              >
                                Remove
                              </ConfirmButton>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
        )}
      </div>
    </>
  );
}

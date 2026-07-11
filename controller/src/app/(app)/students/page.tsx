import { listLabs } from "@/lib/labs";
import { listMembers } from "@/lib/students";
import { ConfirmButton } from "../_components/ConfirmButton";
import { ImportStudentsForm } from "./_components/ImportStudentsForm";
import { importStudentsAction, removeStudentAction } from "./actions";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function StudentsPage() {
  const labs = listLabs();
  // Students are shown grouped by the lab they belong to (a student can be in more than one lab and
  // then appears under each).
  const labsWithMembers = labs.map((l) => ({ lab: l, members: listMembers(l.id) }));
  const totalMemberships = labsWithMembers.reduce((n, l) => n + l.members.length, 0);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Students</h1>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Import from CSV</h3>
          <ImportStudentsForm
            labs={labs.map((l) => ({ id: l.id, name: l.name }))}
            importAction={importStudentsAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <h3 className="text-base font-semibold">Students by lab</h3>
          {totalMemberships === 0 ? (
            <p className="text-sm text-muted-foreground">No students yet.</p>
          ) : (
            labsWithMembers
              .filter((l) => l.members.length > 0)
              .map(({ lab, members }) => (
                <div key={lab.id} className="space-y-2">
                  <h4 className="text-sm font-semibold">
                    <a href={`/labs/${lab.id}`} className="text-primary hover:underline">
                      {lab.name}
                    </a>{" "}
                    <span className="font-normal text-muted-foreground">
                      · {members.length} student{members.length === 1 ? "" : "s"}
                    </span>
                  </h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Username</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Student ID</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((m) => (
                        <TableRow key={m.member_id}>
                          <TableCell>{m.username}</TableCell>
                          <TableCell>{m.email ?? "—"}</TableCell>
                          <TableCell>{m.name ?? "—"}</TableCell>
                          <TableCell>{m.student_id ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            {m.is_pi ? (
                              <span className="text-sm text-muted-foreground">PI · protected</span>
                            ) : (
                            <form action={removeStudentAction} className="flex items-center justify-end gap-2">
                              <input type="hidden" name="labId" value={lab.id} />
                              <input type="hidden" name="studentId" value={m.id} />
                              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <input type="checkbox" name="deleteData" className="accent-primary" /> delete data
                              </label>
                              <ConfirmButton
                                variant="secondary"
                                size="sm"
                                confirm={`Remove ${m.username} from ${lab.name}? If "delete data" is checked, their files are permanently erased.`}
                              >
                                Remove
                              </ConfirmButton>
                            </form>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

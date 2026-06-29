/**
 * Students + logical lab membership. A student is global (reusable across labs). Adding a student to
 * a lab records the membership and provisions them on EVERY placement of that lab (one account per
 * node, each with its own emailed credential); removing them reverses it across all placements.
 */

import { audit } from "./audit";
import { db } from "./db";
import { normalizeEmail } from "./email";
import { getLab } from "./labs";
import { sendRemovalEmail } from "./mailer";
import { generatePassword } from "./passwords";
import {
  type MemberProvision,
  listPlacements,
  provisionMemberOnPlacement,
  removeMemberFromPlacement,
} from "./placements";

export { generatePassword };

export interface Student {
  id: number;
  student_id: string | null;
  username: string;
  email: string | null;
  name: string | null;
}

/** A roster member of a logical lab (no per-student quotas in the redesign — they share lab quota). */
export interface Member extends Student {
  member_id: number;
}

export function listStudents(): Student[] {
  return db().prepare("SELECT * FROM students ORDER BY username").all() as Student[];
}

export function listMembers(labId: number): Member[] {
  return db()
    .prepare(
      `SELECT students.id, students.student_id, students.username, students.email, students.name,
              lab_members.id AS member_id
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? ORDER BY students.username`,
    )
    .all(labId) as Member[];
}

export interface StudentInput {
  username: string;
  email?: string;
  name?: string;
  studentId?: string;
}

/** Find a student by student_id (preferred) then username, creating the record if neither matches. */
export function findOrCreateStudent(input: StudentInput): Student {
  const username = input.username.trim().toLowerCase();
  if (input.studentId) {
    const byId = db().prepare("SELECT * FROM students WHERE student_id = ?").get(input.studentId) as
      | Student
      | undefined;
    if (byId) return byId;
  }
  const byName = db().prepare("SELECT * FROM students WHERE username = ?").get(username) as
    | Student
    | undefined;
  if (byName) return byName;

  const now = Date.now();
  const info = db()
    .prepare(
      "INSERT INTO students (student_id, username, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(input.studentId ?? null, username, normalizeEmail(input.email), input.name ?? null, now, now);
  return db().prepare("SELECT * FROM students WHERE id = ?").get(Number(info.lastInsertRowid)) as Student;
}

export interface AddMemberResult {
  student: Student;
  provisioned: MemberProvision[]; // one entry per placement the student was provisioned on
}

/**
 * Add a student to a lab's roster and provision them on every placement. With no placements yet, the
 * student simply joins the roster (and is provisioned automatically when a placement is later added).
 */
export async function addStudentToLab(
  labId: number,
  student: StudentInput,
  actor?: string,
): Promise<AddMemberResult> {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const record = findOrCreateStudent(student);

  const already = db()
    .prepare("SELECT id FROM lab_members WHERE lab_id = ? AND student_id = ?")
    .get(labId, record.id);
  if (already) throw new Error(`${record.username} is already a member of ${lab.name}`);

  db()
    .prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)")
    .run(labId, record.id, Date.now());
  audit(actor, "member.add", `${lab.name}/${record.username}`);

  const provisioned: MemberProvision[] = [];
  for (const p of listPlacements(labId)) {
    const res = await provisionMemberOnPlacement(p, record, actor);
    if (res) provisioned.push(res);
  }
  return { student: record, provisioned };
}

export interface CopyMembersResult {
  added: number;
  skipped: number;
}

/** Enroll every member of `fromLabId` into `toLabId` (used by create-lab "copy roster" templates). */
export async function copyMembers(
  fromLabId: number,
  toLabId: number,
  actor?: string,
): Promise<CopyMembersResult> {
  const result: CopyMembersResult = { added: 0, skipped: 0 };
  for (const m of listMembers(fromLabId)) {
    const already = db()
      .prepare("SELECT id FROM lab_members WHERE lab_id = ? AND student_id = ?")
      .get(toLabId, m.id);
    if (already) {
      result.skipped += 1;
      continue;
    }
    await addStudentToLab(
      toLabId,
      { username: m.username, email: m.email ?? undefined, name: m.name ?? undefined, studentId: m.student_id ?? undefined },
      actor,
    );
    result.added += 1;
  }
  return result;
}

/**
 * Remove a student from a lab: deprovision them on every placement (optionally deleting their data),
 * drop the membership, and email a notification once. Verifies the student really is a member first.
 */
export function removeStudentFromLab(
  labId: number,
  studentId: number,
  deleteData: boolean,
  actor?: string,
): void {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const member = db()
    .prepare(
      `SELECT students.username AS username, students.email AS email
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? AND lab_members.student_id = ?`,
    )
    .get(labId, studentId) as { username: string; email: string | null } | undefined;
  if (!member) throw new Error("Student is not a member of this lab");

  for (const p of listPlacements(labId)) {
    removeMemberFromPlacement(p, { id: studentId, username: member.username }, deleteData, actor);
  }
  db().prepare("DELETE FROM lab_members WHERE lab_id = ? AND student_id = ?").run(labId, studentId);
  audit(actor, "member.remove", `${lab.name}/${member.username}`, deleteData ? "data deleted" : undefined);
  if (member.email) void sendRemovalEmail(member.email, lab.name, deleteData);
}

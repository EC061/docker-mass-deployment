/**
 * Student data access + lab-membership operations. Adding a student to a lab creates the student
 * record if needed, records membership, enqueues a student.add task to the lab's node, and emails
 * the credentials (best-effort).
 */

import { randomBytes } from "node:crypto";
import { db } from "./db";
import { audit, getLab } from "./labs";
import { sendCredentialEmail, sendRemovalEmail } from "./mailer";
import { enqueueTask } from "./queue";
import { getSetting } from "./settings";

export interface Student {
  id: number;
  student_id: string | null;
  username: string;
  email: string | null;
  name: string | null;
}

export interface Member extends Student {
  member_id: number;
  scratch_quota_bytes: number | null;
  cold_quota_bytes: number | null;
}

export function generatePassword(length = 12): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export function listStudents(): Student[] {
  return db().prepare("SELECT * FROM students ORDER BY username").all() as Student[];
}

export function listMembers(labId: number): Member[] {
  return db()
    .prepare(
      `SELECT students.*, lab_members.id AS member_id,
              lab_members.scratch_quota_bytes, lab_members.cold_quota_bytes
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? ORDER BY students.username`,
    )
    .all(labId) as Member[];
}

export function findOrCreateStudent(input: {
  username: string;
  email?: string;
  name?: string;
  studentId?: string;
}): Student {
  const existing = db()
    .prepare("SELECT * FROM students WHERE username = ?")
    .get(input.username) as Student | undefined;
  if (existing) return existing;
  const info = db()
    .prepare("INSERT INTO students (student_id, username, email, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.studentId ?? null, input.username, input.email ?? null, input.name ?? null, Date.now());
  return db().prepare("SELECT * FROM students WHERE id = ?").get(Number(info.lastInsertRowid)) as Student;
}

export interface AddMemberResult {
  student: Student;
  password: string;
  emailed: boolean;
}

export async function addStudentToLab(
  labId: number,
  student: { username: string; email?: string; name?: string; studentId?: string },
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

  const password = generatePassword();
  enqueueTask(
    lab.node_name,
    "student.add",
    { lab: lab.name, username: record.username, password },
    actor,
  );
  audit(actor, "student.add", `${lab.name}/${record.username}`);

  let emailed = false;
  if (record.email) {
    const host = getSetting("sshHostOverride").trim() || lab.node_name;
    const res = await sendCredentialEmail({
      to: record.email,
      name: record.name ?? undefined,
      username: record.username,
      password,
      host,
      port: lab.ssh_port ?? 22,
      lab: lab.name,
      node: lab.node_name,
      studentId: record.student_id,
    });
    emailed = res.sent;
  }
  return { student: record, password, emailed };
}

export interface CopyMembersResult {
  added: number;
  emailed: number;
  skipped: number; // already members of the destination lab
}

/**
 * Enroll every student of `fromLabId` into `toLabId`. Each gets a fresh account/password on the
 * destination node (same path as a manual add), so credentials are emailed where an address exists.
 * Students already in the destination lab are skipped. Used by "create lab → import students".
 */
export async function copyMembers(
  fromLabId: number,
  toLabId: number,
  actor?: string,
): Promise<CopyMembersResult> {
  const source = listMembers(fromLabId);
  const result: CopyMembersResult = { added: 0, emailed: 0, skipped: 0 };
  for (const m of source) {
    const already = db()
      .prepare("SELECT id FROM lab_members WHERE lab_id = ? AND student_id = ?")
      .get(toLabId, m.id);
    if (already) {
      result.skipped += 1;
      continue;
    }
    const res = await addStudentToLab(
      toLabId,
      { username: m.username, email: m.email ?? undefined, name: m.name ?? undefined, studentId: m.student_id ?? undefined },
      actor,
    );
    result.added += 1;
    if (res.emailed) result.emailed += 1;
  }
  return result;
}

export function removeStudentFromLab(
  labId: number,
  studentId: number,
  deleteData: boolean,
  actor?: string,
): void {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  const student = db().prepare("SELECT username, email FROM students WHERE id = ?").get(studentId) as
    | { username: string; email: string | null }
    | undefined;
  if (!student) return;
  enqueueTask(
    lab.node_name,
    "student.remove",
    { lab: lab.name, username: student.username, delete_data: deleteData },
    actor,
  );
  db().prepare("DELETE FROM lab_members WHERE lab_id = ? AND student_id = ?").run(labId, studentId);
  audit(actor, "student.remove", `${lab.name}/${student.username}`, deleteData ? "data deleted" : undefined);
  if (student.email) void sendRemovalEmail(student.email, lab.name, deleteData);
}

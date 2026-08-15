/**
 * Students + logical lab membership. A student is global (reusable across labs). Adding a student to
 * a lab records the membership and provisions them on EVERY placement of that lab (one account per
 * node, with credentials delivered only after agent confirmation); removal reverses every placement.
 */

import { randomUUID } from "node:crypto";

import { audit } from "./audit";
import { db } from "./db";
import { normalizeEmail } from "./email";
import { getLab } from "./labs";
import { composeName, normalizeDegree, splitFullName } from "./names";
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
  /** Composed display name, derived from first_name + last_name. */
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Academic standing from the roster: PhD / MS / Faculty / … (see lib/names.ts). */
  degree: string | null;
  linux_uid: number;
}

/** A roster member of a logical lab (no per-student quotas in the redesign — they share lab quota). */
export interface Member extends Student {
  member_id: number;
  is_pi: number;
}

export function listStudents(): Student[] {
  return db().prepare("SELECT * FROM students ORDER BY username").all() as Student[];
}

export function listMembers(labId: number): Member[] {
  return db()
    .prepare(
      `SELECT students.id, students.student_id, students.username, students.email, students.name,
              students.first_name, students.last_name, students.degree,
              students.linux_uid, lab_members.id AS member_id,
              CASE WHEN labs.pi_student_id = students.id THEN 1 ELSE 0 END AS is_pi
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       JOIN labs ON labs.id = lab_members.lab_id
       WHERE lab_members.lab_id = ? ORDER BY students.username`,
    )
    .all(labId) as Member[];
}

/** Designate and provision a PI account. The PI uses the ordinary student account path on every
 * placement, but removeStudentFromLab protects the designated account from roster deletion. */
export async function ensurePiAccess(
  labId: number,
  input: StudentInput,
  actor?: string,
): Promise<AddMemberResult> {
  const lab = getLab(labId);
  if (!lab) throw new Error("Unknown lab");
  if (!input.username.trim()) throw new Error("PI username is required to grant placement access");
  const record = findOrCreateStudent(input);
  const current = db().prepare("SELECT pi_student_id FROM labs WHERE id = ?").get(labId) as
    { pi_student_id: number | null };
  if (current.pi_student_id && current.pi_student_id !== record.id) {
    throw new Error("The PI login username cannot be changed after it has been provisioned");
  }

  // Keep the global account's contact details aligned with the lab's PI metadata. A PI may be used
  // by more than one lab; these values are the same real person in that case.
  const profile = studentProfileFields(input);
  db().prepare(
    "UPDATE students SET email = ?, name = ?, first_name = ?, last_name = ?, degree = ?, updated_at = ? WHERE id = ?",
  ).run(normalizeEmail(input.email), profile.name, profile.firstName, profile.lastName,
    profile.degree ?? record.degree, Date.now(), record.id);
  db().prepare("UPDATE labs SET pi_student_id = ?, pi_name = ?, pi_email = ?, updated_at = ? WHERE id = ?")
    .run(record.id, profile.name, normalizeEmail(input.email), Date.now(), labId);

  const member = db().prepare("SELECT 1 FROM lab_members WHERE lab_id = ? AND student_id = ?")
    .get(labId, record.id);
  if (!member) {
    db().prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)")
      .run(labId, record.id, Date.now());
  }
  audit(actor, "pi.access.ensure", `${lab.name}/${record.username}`);

  const provisioned: MemberProvision[] = [];
  for (const p of listPlacements(labId)) {
    const res = await provisionMemberOnPlacement(p, record, actor);
    if (res) provisioned.push(res);
  }
  return { student: record, provisioned };
}

export interface StudentInput {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** Legacy single-field name; used only when firstName/lastName are absent (split on its last space). */
  name?: string;
  /** Academic standing ("PhD", "MS", "Faculty", …); normalized before it is stored. */
  degree?: string;
  studentId?: string;
}

export interface StudentProfileFields {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  degree: string | null;
}

/** Resolve an input's name parts + degree to what gets stored (see lib/names.ts). */
export function studentProfileFields(input: StudentInput): StudentProfileFields {
  const legacy = splitFullName(input.name);
  const firstName = (input.firstName ?? "").trim() || legacy.firstName;
  const lastName = (input.lastName ?? "").trim() || legacy.lastName;
  return {
    firstName: firstName || null,
    lastName: lastName || null,
    name: composeName(firstName, lastName),
    degree: normalizeDegree(input.degree),
  };
}

/**
 * Refresh a known student's contact details from an import/edit. Only non-blank incoming values are
 * written, so a sparse row never blanks out details another source already filled in. Returns true
 * when something actually changed.
 */
export function updateStudentProfile(id: number, input: StudentInput): boolean {
  const current = db().prepare("SELECT * FROM students WHERE id = ?").get(id) as Student | undefined;
  if (!current) return false;
  const profile = studentProfileFields(input);
  const email = normalizeEmail(input.email);
  const studentId = input.studentId?.trim() || null;

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (email && email !== current.email) set("email", email);
  if (profile.firstName && profile.firstName !== current.first_name) set("first_name", profile.firstName);
  if (profile.lastName && profile.lastName !== current.last_name) set("last_name", profile.lastName);
  if (profile.name && profile.name !== current.name) set("name", profile.name);
  if (profile.degree && profile.degree !== current.degree) set("degree", profile.degree);
  if (studentId && !current.student_id) set("student_id", studentId);
  if (sets.length === 0) return false;

  sets.push("updated_at = ?");
  values.push(Date.now(), id);
  db().prepare(`UPDATE students SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return true;
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

  return db().transaction(() => {
    const used = new Set(
      (db().prepare("SELECT linux_uid FROM students WHERE linux_uid IS NOT NULL").all() as
        { linux_uid: number }[]).map((row) => row.linux_uid),
    );
    let linuxUid = 10_000;
    while (linuxUid <= 59_999 && used.has(linuxUid)) linuxUid++;
    if (linuxUid > 59_999) throw new Error("student UID range 10000..59999 is exhausted");
    const now = Date.now();
    const profile = studentProfileFields(input);
    const info = db()
      .prepare(
        `INSERT INTO students
          (student_id, username, email, name, first_name, last_name, degree, linux_uid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.studentId ?? null, username, normalizeEmail(input.email), profile.name,
        profile.firstName, profile.lastName, profile.degree, linuxUid, now, now);
    return db().prepare("SELECT * FROM students WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Student;
  })();
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
      {
        username: m.username,
        email: m.email ?? undefined,
        firstName: m.first_name ?? undefined,
        lastName: m.last_name ?? undefined,
        degree: m.degree ?? undefined,
        studentId: m.student_id ?? undefined,
      },
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
  const protectedPi = db().prepare("SELECT 1 FROM labs WHERE id = ? AND pi_student_id = ?")
    .get(labId, studentId);
  if (protectedPi) throw new Error("The PI account is protected and cannot be removed from the lab");
  const member = db()
    .prepare(
      `SELECT students.username AS username, students.email AS email
       FROM lab_members JOIN students ON students.id = lab_members.student_id
       WHERE lab_members.lab_id = ? AND lab_members.student_id = ?`,
    )
    .get(labId, studentId) as { username: string; email: string | null } | undefined;
  if (!member) throw new Error("Student is not a member of this lab");

  const placements = listPlacements(labId);
  const coldCleanupNodes = deleteData
    ? placements.filter((p) => p.node_cold_backend === "local_zfs").map((p) => p.node_name)
    : [];
  const removal = deleteData && placements.length > 0
    ? { id: randomUUID(), coldCleanupNodes }
    : undefined;
  for (const p of placements) {
    removeMemberFromPlacement(
      p,
      { id: studentId, username: member.username },
      deleteData,
      actor,
      removal,
    );
  }
  db().prepare("DELETE FROM lab_members WHERE lab_id = ? AND student_id = ?").run(labId, studentId);
  audit(actor, "member.remove", `${lab.name}/${member.username}`, deleteData ? "data deleted" : undefined);
  if (member.email) void sendRemovalEmail(member.email, lab.name, deleteData);
}

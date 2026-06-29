/**
 * Lab + roster CSV import (Phase 2). One row per lab/student membership:
 *
 *   lab_name,pi_name,pi_email,student_id,username,student_name,student_email
 *
 * The whole file is parsed and validated against the current DB BEFORE any write, producing a plan
 * (labs/students to create or update, memberships to add, plus conflicts / invalid rows). The plan is
 * shown as a preview; applying it re-derives the plan and commits everything in one transaction, then
 * records an audit row. Imports are idempotent (re-running changes nothing) and never delete a lab or
 * membership merely because it is absent from a later CSV. Node/quota/image config is NOT in the CSV.
 */

import { audit } from "./audit";
import { parseCsv } from "./csv";
import { db } from "./db";
import { isValidLabName } from "./labs";
import { listPlacements, provisionMemberOnPlacement, type ProvisionStudent } from "./placements";

export const MAX_IMPORT_BYTES = 1_000_000; // 1 MB
export const MAX_IMPORT_ROWS = 5_000;

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STUDENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ImportIssue {
  line: number; // 1-based CSV line (header is line 1)
  message: string;
}

export interface LabCreate {
  name: string;
  piName: string | null;
  piEmail: string | null;
}
export interface LabUpdate {
  name: string;
  piName?: string;
  piEmail?: string;
}
export interface StudentCreate {
  username: string;
  studentId: string | null;
  name: string | null;
  email: string | null;
}
export interface StudentUpdate {
  username: string;
  studentId?: string;
  name?: string;
  email?: string;
}
export interface MembershipAdd {
  lab: string;
  username: string;
}

export interface ImportPlan {
  labsToCreate: LabCreate[];
  labsToUpdate: LabUpdate[];
  studentsToCreate: StudentCreate[];
  studentsToUpdate: StudentUpdate[];
  membershipsToAdd: MembershipAdd[];
  conflicts: ImportIssue[];
  invalid: ImportIssue[];
  ok: boolean; // committable: no conflicts and no invalid rows
}

interface ValidRow {
  line: number;
  lab: string;
  piName: string | null;
  piEmail: string | null;
  sid: string | null;
  user: string | null;
  sname: string | null;
  semail: string | null;
  hasStudent: boolean;
}

interface DbStudent {
  id: number;
  student_id: string | null;
  username: string;
  email: string | null;
  name: string | null;
}
interface DbLab {
  id: number;
  pi_name: string | null;
  pi_email: string | null;
}

const norm = (v: string | undefined) => (v ?? "").trim();
const lower = (v: string | undefined) => norm(v).toLowerCase();

function emptyPlan(issue?: ImportIssue): ImportPlan {
  return {
    labsToCreate: [],
    labsToUpdate: [],
    studentsToCreate: [],
    studentsToUpdate: [],
    membershipsToAdd: [],
    conflicts: [],
    invalid: issue ? [issue] : [],
    ok: false,
  };
}

/** Compute an import plan from CSV text WITHOUT writing anything. Reads current DB state. */
export function planLabImport(text: string): ImportPlan {
  if (text.length > MAX_IMPORT_BYTES) {
    return emptyPlan({ line: 0, message: `File too large (${text.length} bytes; max ${MAX_IMPORT_BYTES})` });
  }
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) return emptyPlan({ line: 0, message: "Empty CSV" });
  if (!parsed.headers.includes("lab_name")) {
    return emptyPlan({ line: 1, message: "Missing required column 'lab_name'" });
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return emptyPlan({ line: 0, message: `Too many rows (${parsed.rows.length}; max ${MAX_IMPORT_ROWS})` });
  }

  const invalid: ImportIssue[] = [];
  const conflicts: ImportIssue[] = [];
  const valid: ValidRow[] = [];

  // Phase A — per-row field validation.
  parsed.rows.forEach((r, i) => {
    const line = i + 2; // +1 header, +1 to 1-base
    const bad = (message: string) => invalid.push({ line, message });
    const lab = norm(r.lab_name);
    if (!lab) return void bad("missing lab_name");
    if (!isValidLabName(lab)) return void bad(`invalid lab_name '${lab}'`);
    const piName = norm(r.pi_name) || null;
    const piEmail = lower(r.pi_email) || null;
    if (piEmail && !EMAIL_RE.test(piEmail)) return void bad("invalid pi_email");
    const sid = norm(r.student_id) || null;
    const user = lower(r.username) || null;
    const sname = norm(r.student_name) || null;
    const semail = lower(r.student_email) || null;
    const hasStudent = !!(sid || user || sname || semail);
    if (hasStudent && !user) return void bad("username required when any student field is present");
    if (user && !USERNAME_RE.test(user)) return void bad(`invalid username '${user}'`);
    if (sid && !STUDENT_ID_RE.test(sid)) return void bad(`invalid student_id '${sid}'`);
    if (semail && !EMAIL_RE.test(semail)) return void bad("invalid student_email");
    valid.push({ line, lab, piName, piEmail, sid, user, sname, semail, hasStudent });
  });

  // Phase B — PI consistency per lab (repeated PI info for one lab must match).
  const labPI = new Map<string, { piName: string | null; piEmail: string | null }>();
  for (const r of valid) {
    const cur = labPI.get(r.lab);
    if (!cur) {
      labPI.set(r.lab, { piName: r.piName, piEmail: r.piEmail });
      continue;
    }
    if (r.piName && cur.piName && r.piName !== cur.piName) conflicts.push({ line: r.line, message: `PI name mismatch for lab '${r.lab}'` });
    else if (r.piName && !cur.piName) cur.piName = r.piName;
    if (r.piEmail && cur.piEmail && r.piEmail !== cur.piEmail) conflicts.push({ line: r.line, message: `PI email mismatch for lab '${r.lab}'` });
    else if (r.piEmail && !cur.piEmail) cur.piEmail = r.piEmail;
  }

  // Load current DB state.
  const dbLabs = new Map<string, DbLab>();
  for (const l of db().prepare("SELECT id, name, pi_name, pi_email FROM labs").all() as (DbLab & { name: string })[]) {
    dbLabs.set(l.name, { id: l.id, pi_name: l.pi_name, pi_email: l.pi_email });
  }
  const dbByName = new Map<string, DbStudent>();
  const dbById = new Map<string, DbStudent>();
  for (const s of db().prepare("SELECT id, student_id, username, email, name FROM students").all() as DbStudent[]) {
    dbByName.set(s.username, s);
    if (s.student_id) dbById.set(s.student_id, s);
  }
  const dbMembers = new Set<string>();
  for (const m of db().prepare("SELECT lab_id, student_id FROM lab_members").all() as { lab_id: number; student_id: number }[]) {
    dbMembers.add(`${m.lab_id}:${m.student_id}`);
  }

  // Phase C — merge student rows by username, detecting in-batch conflicts.
  interface BatchStudent { sid: string | null; name: string | null; email: string | null; line: number }
  const batch = new Map<string, BatchStudent>();
  for (const r of valid) {
    if (!r.hasStudent || !r.user) continue;
    const prev = batch.get(r.user);
    if (!prev) {
      batch.set(r.user, { sid: r.sid, name: r.sname, email: r.semail, line: r.line });
    } else {
      if (r.sid && prev.sid && r.sid !== prev.sid) conflicts.push({ line: r.line, message: `username '${r.user}' mapped to two student IDs` });
      else if (r.sid && !prev.sid) prev.sid = r.sid;
      if (r.sname && !prev.name) prev.name = r.sname;
      if (r.semail && !prev.email) prev.email = r.semail;
    }
  }
  // Two usernames sharing one student_id within the batch is a conflict.
  const seenSid = new Map<string, string>();
  for (const [user, info] of batch) {
    if (!info.sid) continue;
    const other = seenSid.get(info.sid);
    if (other && other !== user) conflicts.push({ line: info.line, message: `student_id '${info.sid}' used by two usernames ('${other}', '${user}')` });
    else seenSid.set(info.sid, user);
  }

  // Phase C2 — resolve each batch student against the DB (create vs update vs conflict).
  const studentsToCreate: StudentCreate[] = [];
  const studentsToUpdate: StudentUpdate[] = [];
  for (const [user, info] of batch) {
    const byId = info.sid ? dbById.get(info.sid) : undefined;
    const byName = dbByName.get(user);
    if (byId && byId.username !== user) {
      conflicts.push({ line: info.line, message: `student_id '${info.sid}' already belongs to '${byId.username}'` });
      continue;
    }
    if (byName && byName.student_id && info.sid && byName.student_id !== info.sid) {
      conflicts.push({ line: info.line, message: `username '${user}' already has student_id '${byName.student_id}'` });
      continue;
    }
    const existing = byId ?? byName;
    if (!existing) {
      studentsToCreate.push({ username: user, studentId: info.sid, name: info.name, email: info.email });
      continue;
    }
    const upd: StudentUpdate = { username: user };
    if (info.name && info.name !== existing.name) upd.name = info.name;
    if (info.email && info.email !== existing.email) upd.email = info.email;
    if (info.sid && !existing.student_id) upd.studentId = info.sid;
    if (upd.name !== undefined || upd.email !== undefined || upd.studentId !== undefined) studentsToUpdate.push(upd);
  }

  // Phase D — labs to create / update (only changed, non-blank PI fields).
  const labsToCreate: LabCreate[] = [];
  const labsToUpdate: LabUpdate[] = [];
  for (const [lab, pi] of labPI) {
    const existing = dbLabs.get(lab);
    if (!existing) {
      labsToCreate.push({ name: lab, piName: pi.piName, piEmail: pi.piEmail });
    } else {
      const upd: LabUpdate = { name: lab };
      if (pi.piName !== null && pi.piName !== existing.pi_name) upd.piName = pi.piName;
      if (pi.piEmail !== null && pi.piEmail !== existing.pi_email) upd.piEmail = pi.piEmail;
      if (upd.piName !== undefined || upd.piEmail !== undefined) labsToUpdate.push(upd);
    }
  }

  // Phase E — memberships to add (dedup; skip ones that already exist in the DB).
  const membershipsToAdd: MembershipAdd[] = [];
  const seenMember = new Set<string>();
  for (const r of valid) {
    if (!r.hasStudent || !r.user) continue;
    const key = `${r.lab} ${r.user}`;
    if (seenMember.has(key)) continue;
    seenMember.add(key);
    const dbLab = dbLabs.get(r.lab);
    const dbStudent = dbByName.get(r.user) ?? (r.sid ? dbById.get(r.sid) : undefined);
    if (dbLab && dbStudent && dbMembers.has(`${dbLab.id}:${dbStudent.id}`)) continue; // already a member -> idempotent
    membershipsToAdd.push({ lab: r.lab, username: r.user });
  }

  return {
    labsToCreate,
    labsToUpdate,
    studentsToCreate,
    studentsToUpdate,
    membershipsToAdd,
    conflicts,
    invalid,
    ok: conflicts.length === 0 && invalid.length === 0,
  };
}

export interface ImportResult {
  labsCreated: number;
  labsUpdated: number;
  studentsCreated: number;
  studentsUpdated: number;
  membershipsAdded: number;
  provisioned: number; // memberships provisioned on an existing placement
  emailed: number;
}

/**
 * Apply an import: re-derive the plan from the text (never trust a client-supplied plan), commit all
 * labs/students/memberships in ONE transaction, audit it, then provision any newly-added memberships
 * on labs that already have placements (best-effort, post-commit). Throws if the plan isn't committable.
 */
export async function applyLabImport(text: string, actor?: string): Promise<ImportResult> {
  const plan = planLabImport(text);
  if (!plan.ok) {
    const first = [...plan.invalid, ...plan.conflicts][0];
    throw new Error(
      `Import not committable: ${plan.invalid.length} invalid row(s), ${plan.conflicts.length} conflict(s)` +
        (first ? ` — first: line ${first.line}: ${first.message}` : ""),
    );
  }

  const now = Date.now();
  const labId = new Map<string, number>();
  const studentId = new Map<string, number>();
  const added: { labId: number; student: ProvisionStudent }[] = [];

  db().transaction(() => {
    const dbName = (sql: string) => db().prepare(sql);
    // Seed maps with existing rows referenced by memberships.
    for (const l of db().prepare("SELECT id, name FROM labs").all() as { id: number; name: string }[]) labId.set(l.name, l.id);
    for (const s of db().prepare("SELECT id, username FROM students").all() as { id: number; username: string }[]) studentId.set(s.username, s.id);

    for (const l of plan.labsToCreate) {
      const info = dbName("INSERT INTO labs (name, pi_name, pi_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(l.name, l.piName, l.piEmail, now, now);
      labId.set(l.name, Number(info.lastInsertRowid));
    }
    for (const l of plan.labsToUpdate) {
      if (l.piName !== undefined) dbName("UPDATE labs SET pi_name = ? WHERE name = ?").run(l.piName, l.name);
      if (l.piEmail !== undefined) dbName("UPDATE labs SET pi_email = ? WHERE name = ?").run(l.piEmail, l.name);
      dbName("UPDATE labs SET updated_at = ? WHERE name = ?").run(now, l.name);
    }
    for (const s of plan.studentsToCreate) {
      const info = dbName("INSERT INTO students (student_id, username, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.studentId, s.username, s.email, s.name, now, now);
      studentId.set(s.username, Number(info.lastInsertRowid));
    }
    for (const s of plan.studentsToUpdate) {
      if (s.studentId !== undefined) dbName("UPDATE students SET student_id = ? WHERE username = ?").run(s.studentId, s.username);
      if (s.name !== undefined) dbName("UPDATE students SET name = ? WHERE username = ?").run(s.name, s.username);
      if (s.email !== undefined) dbName("UPDATE students SET email = ? WHERE username = ?").run(s.email, s.username);
      dbName("UPDATE students SET updated_at = ? WHERE username = ?").run(now, s.username);
    }
    for (const m of plan.membershipsToAdd) {
      const lid = labId.get(m.lab)!;
      const sid = studentId.get(m.username)!;
      const exists = dbName("SELECT 1 FROM lab_members WHERE lab_id = ? AND student_id = ?").get(lid, sid);
      if (!exists) {
        dbName("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)").run(lid, sid, now);
        const student = db().prepare("SELECT id, username, email, name, student_id FROM students WHERE id = ?").get(sid) as ProvisionStudent;
        added.push({ labId: lid, student });
      }
    }
  })();

  const result: ImportResult = {
    labsCreated: plan.labsToCreate.length,
    labsUpdated: plan.labsToUpdate.length,
    studentsCreated: plan.studentsToCreate.length,
    studentsUpdated: plan.studentsToUpdate.length,
    membershipsAdded: added.length,
    provisioned: 0,
    emailed: 0,
  };
  audit(actor, "lab.import", undefined, JSON.stringify(result));

  // Provision newly-added members on any placements the lab already has (no-op pre-rollout, when
  // labs have no placements yet). Best-effort and outside the DB transaction (it enqueues + emails).
  for (const a of added) {
    for (const p of listPlacements(a.labId)) {
      const res = await provisionMemberOnPlacement(p, a.student, actor);
      if (res) {
        result.provisioned += 1;
        if (res.emailed) result.emailed += 1;
      }
    }
  }
  return result;
}

/**
 * Per-lab roster CSV import (Phase 2, role-based). The import is scoped to a single lab (run from that
 * lab's page), so the lab is never named in the file and PI info is not repeated on every row. Columns:
 *
 *   role,username,email,name,student_id
 *
 * `role` is `student` (the default when the column is blank or absent) or `pi`. A `pi` row carries the
 * lab's PI metadata only — its `name`/`email` become the lab's PI name/email and any username/student_id
 * on it is ignored (the PI is not a roster member). `student` rows create/update the global student
 * record and add a membership to THIS lab.
 *
 * The whole file is parsed and validated against the current DB BEFORE any write, producing a plan
 * (PI change, students to create/update, memberships to add, plus conflicts / invalid rows). The plan is
 * shown as a preview; applying it re-derives the plan and commits everything in one transaction, then
 * records an audit row. Imports are idempotent (re-running changes nothing) and never remove a member
 * merely because they are absent from a later CSV. Node/quota/image config is NOT in the CSV.
 */

import { audit } from "./audit";
import { parseCsv } from "./csv";
import { db } from "./db";
import { getLab } from "./labs";
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
/** The PI fields that would change on this lab (only changed, non-blank fields are present). */
export interface PiUpdate {
  piName?: string;
  piEmail?: string;
}

export interface RosterImportPlan {
  lab: string; // target lab name, for display
  piUpdate: PiUpdate | null;
  studentsToCreate: StudentCreate[];
  studentsToUpdate: StudentUpdate[];
  membershipsToAdd: string[]; // usernames to add to this lab's roster
  conflicts: ImportIssue[];
  invalid: ImportIssue[];
  ok: boolean; // committable: no conflicts and no invalid rows
}

interface ValidRow {
  line: number;
  role: "student" | "pi";
  user: string | null;
  sid: string | null;
  sname: string | null;
  semail: string | null;
}

interface DbStudent {
  id: number;
  student_id: string | null;
  username: string;
  email: string | null;
  name: string | null;
}

const norm = (v: string | undefined) => (v ?? "").trim();
const lower = (v: string | undefined) => norm(v).toLowerCase();

function emptyPlan(lab: string, issue?: ImportIssue): RosterImportPlan {
  return {
    lab,
    piUpdate: null,
    studentsToCreate: [],
    studentsToUpdate: [],
    membershipsToAdd: [],
    conflicts: [],
    invalid: issue ? [issue] : [],
    ok: false,
  };
}

/** Compute a per-lab roster import plan from CSV text WITHOUT writing anything. Reads current DB state. */
export function planRosterImport(labId: number, text: string): RosterImportPlan {
  const lab = getLab(labId);
  if (!lab) return emptyPlan("", { line: 0, message: "Unknown lab" });
  if (text.length > MAX_IMPORT_BYTES) {
    return emptyPlan(lab.name, { line: 0, message: `File too large (${text.length} bytes; max ${MAX_IMPORT_BYTES})` });
  }
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) return emptyPlan(lab.name, { line: 0, message: "Empty CSV" });
  if (!parsed.headers.includes("username")) {
    return emptyPlan(lab.name, { line: 1, message: "Missing required column 'username'" });
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return emptyPlan(lab.name, { line: 0, message: `Too many rows (${parsed.rows.length}; max ${MAX_IMPORT_ROWS})` });
  }

  const invalid: ImportIssue[] = [];
  const conflicts: ImportIssue[] = [];
  const valid: ValidRow[] = [];

  // Phase A — per-row field validation. `role` defaults to student when blank/absent.
  parsed.rows.forEach((r, i) => {
    const line = i + 2; // +1 header, +1 to 1-base
    const bad = (message: string) => invalid.push({ line, message });
    const roleRaw = lower(r.role) || "student";
    if (roleRaw !== "student" && roleRaw !== "pi") return void bad(`unknown role '${roleRaw}' (use 'student' or 'pi')`);
    const role = roleRaw;
    const user = lower(r.username) || null;
    const sid = norm(r.student_id) || null;
    const sname = norm(r.name) || null;
    const semail = lower(r.email) || null;

    if (role === "pi") {
      if (!sname && !semail) return void bad("a 'pi' row needs a name or email");
      if (semail && !EMAIL_RE.test(semail)) return void bad("invalid pi email");
      valid.push({ line, role, user: null, sid: null, sname, semail });
      return;
    }
    // student row
    if (!user) return void bad("username required on a student row");
    if (!USERNAME_RE.test(user)) return void bad(`invalid username '${user}'`);
    if (sid && !STUDENT_ID_RE.test(sid)) return void bad(`invalid student_id '${sid}'`);
    if (semail && !EMAIL_RE.test(semail)) return void bad("invalid email");
    valid.push({ line, role, user, sid, sname, semail });
  });

  // Phase B — PI metadata: at most one effective PI (repeated 'pi' rows must agree).
  let piName: string | null = null;
  let piEmail: string | null = null;
  for (const r of valid) {
    if (r.role !== "pi") continue;
    if (r.sname) {
      if (piName && piName !== r.sname) conflicts.push({ line: r.line, message: "conflicting PI name in 'pi' rows" });
      else piName = r.sname;
    }
    if (r.semail) {
      if (piEmail && piEmail !== r.semail) conflicts.push({ line: r.line, message: "conflicting PI email in 'pi' rows" });
      else piEmail = r.semail;
    }
  }

  // Load current DB state for this lab.
  const dbByName = new Map<string, DbStudent>();
  const dbById = new Map<string, DbStudent>();
  for (const s of db().prepare("SELECT id, student_id, username, email, name FROM students").all() as DbStudent[]) {
    dbByName.set(s.username, s);
    if (s.student_id) dbById.set(s.student_id, s);
  }
  const dbMembers = new Set<number>();
  for (const m of db().prepare("SELECT student_id FROM lab_members WHERE lab_id = ?").all(labId) as { student_id: number }[]) {
    dbMembers.add(m.student_id);
  }

  // Phase C — merge student rows by username, detecting in-batch conflicts.
  interface BatchStudent { sid: string | null; name: string | null; email: string | null; line: number }
  const batch = new Map<string, BatchStudent>();
  for (const r of valid) {
    if (r.role !== "student" || !r.user) continue;
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

  // PI update — only changed, non-blank fields relative to the lab's current PI.
  let piUpdate: PiUpdate | null = null;
  const pi: PiUpdate = {};
  if (piName !== null && piName !== lab.pi_name) pi.piName = piName;
  if (piEmail !== null && piEmail !== lab.pi_email) pi.piEmail = piEmail;
  if (pi.piName !== undefined || pi.piEmail !== undefined) piUpdate = pi;

  // Memberships to add (dedup; skip students already in this lab's roster).
  const membershipsToAdd: string[] = [];
  const seenMember = new Set<string>();
  for (const [user] of batch) {
    if (seenMember.has(user)) continue;
    seenMember.add(user);
    const existing = dbByName.get(user) ?? (batch.get(user)?.sid ? dbById.get(batch.get(user)!.sid!) : undefined);
    if (existing && dbMembers.has(existing.id)) continue; // already a member -> idempotent
    membershipsToAdd.push(user);
  }

  return {
    lab: lab.name,
    piUpdate,
    studentsToCreate,
    studentsToUpdate,
    membershipsToAdd,
    conflicts,
    invalid,
    ok: conflicts.length === 0 && invalid.length === 0,
  };
}

export interface RosterImportResult {
  piUpdated: boolean;
  studentsCreated: number;
  studentsUpdated: number;
  membershipsAdded: number;
  provisioned: number; // memberships queued on an existing placement
}

/**
 * Apply a per-lab roster import: re-derive the plan from the text (never trust a client-supplied plan),
 * commit the PI change + students + memberships in ONE transaction, audit it, then provision any
 * newly-added members on placements the lab already has (best-effort, post-commit). Throws if the plan
 * isn't committable.
 */
export async function applyRosterImport(labId: number, text: string, actor?: string): Promise<RosterImportResult> {
  const plan = planRosterImport(labId, text);
  if (!plan.ok) {
    const first = [...plan.invalid, ...plan.conflicts][0];
    throw new Error(
      `Import not committable: ${plan.invalid.length} invalid row(s), ${plan.conflicts.length} conflict(s)` +
        (first ? ` — first: line ${first.line}: ${first.message}` : ""),
    );
  }

  const now = Date.now();
  const studentId = new Map<string, number>();
  const added: ProvisionStudent[] = [];

  db().transaction(() => {
    const stmt = (sql: string) => db().prepare(sql);
    const usedUids = new Set((stmt("SELECT linux_uid FROM students WHERE linux_uid IS NOT NULL").all() as
      { linux_uid: number }[]).map((row) => row.linux_uid));
    const takeUid = () => {
      let uid = 10_000;
      while (uid <= 59_999 && usedUids.has(uid)) uid++;
      if (uid > 59_999) throw new Error("student UID range 10000..59999 is exhausted");
      usedUids.add(uid);
      return uid;
    };
    for (const s of db().prepare("SELECT id, username FROM students").all() as { id: number; username: string }[]) {
      studentId.set(s.username, s.id);
    }

    if (plan.piUpdate) {
      if (plan.piUpdate.piName !== undefined) stmt("UPDATE labs SET pi_name = ? WHERE id = ?").run(plan.piUpdate.piName, labId);
      if (plan.piUpdate.piEmail !== undefined) stmt("UPDATE labs SET pi_email = ? WHERE id = ?").run(plan.piUpdate.piEmail, labId);
      stmt("UPDATE labs SET updated_at = ? WHERE id = ?").run(now, labId);
    }
    for (const s of plan.studentsToCreate) {
      const info = stmt("INSERT INTO students (student_id, username, email, name, linux_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(s.studentId, s.username, s.email, s.name, takeUid(), now, now);
      studentId.set(s.username, Number(info.lastInsertRowid));
    }
    for (const s of plan.studentsToUpdate) {
      if (s.studentId !== undefined) stmt("UPDATE students SET student_id = ? WHERE username = ?").run(s.studentId, s.username);
      if (s.name !== undefined) stmt("UPDATE students SET name = ? WHERE username = ?").run(s.name, s.username);
      if (s.email !== undefined) stmt("UPDATE students SET email = ? WHERE username = ?").run(s.email, s.username);
      stmt("UPDATE students SET updated_at = ? WHERE username = ?").run(now, s.username);
    }
    for (const user of plan.membershipsToAdd) {
      const sid = studentId.get(user)!;
      const exists = stmt("SELECT 1 FROM lab_members WHERE lab_id = ? AND student_id = ?").get(labId, sid);
      if (!exists) {
        stmt("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (?, ?, ?)").run(labId, sid, now);
        const student = db().prepare("SELECT id, username, email, name, student_id, linux_uid FROM students WHERE id = ?").get(sid) as ProvisionStudent;
        added.push(student);
      }
    }
  })();

  const result: RosterImportResult = {
    piUpdated: plan.piUpdate !== null,
    studentsCreated: plan.studentsToCreate.length,
    studentsUpdated: plan.studentsToUpdate.length,
    membershipsAdded: added.length,
    provisioned: 0,
  };
  audit(actor, "lab.roster_import", plan.lab, JSON.stringify(result));

  // Provision newly-added members on any placements the lab already has. Credentials are delivered only
  // after each agent confirms success.
  for (const student of added) {
    for (const p of listPlacements(labId)) {
      const res = await provisionMemberOnPlacement(p, student, actor);
      if (res) result.provisioned += 1;
    }
  }
  return result;
}

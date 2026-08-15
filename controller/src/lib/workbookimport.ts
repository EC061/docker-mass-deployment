/**
 * Whole-workbook import: one .xlsx, one lab per sheet.
 *
 * The department maintains a single "Lab Information For Server Management" workbook where each tab
 * is a lab (the tab name IS the lab name, e.g. `Geng_Yuan_Lab`) and each row is a person:
 *
 *   First Name | Last Name | UGA ID | Email | MS or PhD
 *
 * The UGA ID becomes the login username (and the student ID), Email becomes the contact address, and
 * the "MS or PhD" column is the person's standing — the row marked `Faculty` is the lab's PI and is
 * provisioned through the ordinary protected-PI path. Labs named by a sheet that does not exist yet
 * are created, so an admin never has to pre-create labs by hand.
 *
 * The workbook is parsed in the browser (lib/xlsx.ts) and only the resulting string grids are posted
 * here; this module re-derives everything server-side — headers, usernames, emails, PI designation —
 * so the browser is never trusted. Nothing is written during planning: the plan is previewed, then
 * applying re-derives it and commits. This is roster information only — no node, quota, or image
 * config — and re-importing the same workbook is idempotent.
 */

import { audit } from "./audit";
import { db } from "./db";
import { LAB_NAME_RE, createLab, getLabByName } from "./labs";
import { composeName, isFacultyDegree, normalizeDegree } from "./names";
import {
  addStudentToLab,
  ensurePiAccess,
  findOrCreateStudent,
  updateStudentProfile,
  type StudentInput,
} from "./students";

export const MAX_WORKBOOK_SHEETS = 100;
export const MAX_WORKBOOK_ROWS = 2_000; // per sheet

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One parsed sheet as posted by the browser: the raw cell grid, header row included. */
export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

export interface WorkbookIssue {
  /** 1-based row in the sheet (as shown in Excel); 0 for a problem with the sheet as a whole. */
  line: number;
  message: string;
}

export type PersonAction = "create" | "update" | "unchanged";

export interface WorkbookPerson {
  line: number;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  degree: string | null;
  isPi: boolean;
  /** What happens to the global student record. */
  action: PersonAction;
  /** Already on this lab's roster (so the import adds nothing for them). */
  alreadyMember: boolean;
}

export interface WorkbookLabPlan {
  sheet: string;
  /** Lab name derived from the sheet name (sanitized to the lab-name charset). */
  lab: string;
  labExists: boolean;
  people: WorkbookPerson[];
  piUsername: string | null;
  membersToAdd: number;
  studentsToCreate: number;
  studentsToUpdate: number;
  issues: WorkbookIssue[];
  warnings: string[];
  ok: boolean;
}

export interface WorkbookImportPlan {
  labs: WorkbookLabPlan[];
  labsToCreate: number;
  studentsToCreate: number;
  studentsToUpdate: number;
  membersToAdd: number;
  /** Problems that are not tied to a single sheet (e.g. two sheets mapping to one lab name). */
  issues: string[];
  ok: boolean;
}

export interface WorkbookImportResult {
  labsCreated: string[];
  labsUpdated: string[];
  pisSet: number;
  studentsCreated: number;
  studentsUpdated: number;
  membershipsAdded: number;
  /** Memberships queued on placements the lab already had (normally 0 — labs are imported first). */
  provisioned: number;
}

// ---------------------------------------------------------------------------- column mapping

type Column = "firstName" | "lastName" | "username" | "email" | "degree";

/** Header spellings we accept, normalized to lowercase alphanumerics (so "UGA ID" == "ugaid"). */
const HEADERS: Record<Column, string[]> = {
  firstName: ["firstname", "first", "givenname", "given", "fname"],
  lastName: ["lastname", "last", "surname", "familyname", "lname"],
  username: ["ugaid", "ugamyid", "myid", "username", "userid", "netid", "login", "id"],
  email: ["email", "emailaddress", "mail", "ugaemail"],
  degree: ["msorphd", "msphd", "degree", "program", "standing", "role", "status", "position", "title"],
};

const headerKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Mapping {
  headerRow: number; // 0-based index into sheet.rows
  columns: Partial<Record<Column, number>>;
}

/** Locate the header row (searching the first few rows) and map its columns. */
function mapColumns(rows: string[][]): Mapping | null {
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const columns: Partial<Record<Column, number>> = {};
    rows[r].forEach((cell, index) => {
      const key = headerKey(cell);
      if (!key) return;
      for (const column of Object.keys(HEADERS) as Column[]) {
        if (columns[column] === undefined && HEADERS[column].includes(key)) columns[column] = index;
      }
    });
    if (columns.username !== undefined) return { headerRow: r, columns };
  }
  return null;
}

/** Sheet name -> lab name: keep the lab-name charset, collapse anything else to an underscore. */
export function labNameFromSheet(sheet: string): string {
  const cleaned = sheet
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 40)
    .replace(/[_-]+$/, "");
  return cleaned;
}

// ---------------------------------------------------------------------------- planning

interface DbStudent {
  id: number;
  student_id: string | null;
  username: string;
  email: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  degree: string | null;
}

/** What the import would write for one person, given the current DB state. */
function personAction(existing: DbStudent | undefined, person: WorkbookPerson): PersonAction {
  if (!existing) return "create";
  const name = composeName(person.firstName, person.lastName);
  const changes =
    (person.email && person.email !== existing.email) ||
    (person.firstName && person.firstName !== existing.first_name) ||
    (person.lastName && person.lastName !== existing.last_name) ||
    (name && name !== existing.name) ||
    (person.degree && person.degree !== existing.degree) ||
    !existing.student_id;
  return changes ? "update" : "unchanged";
}

function planSheet(
  sheet: WorkbookSheet,
  students: { byUsername: Map<string, DbStudent>; byStudentId: Map<string, DbStudent> },
): WorkbookLabPlan {
  const issues: WorkbookIssue[] = [];
  const warnings: string[] = [];
  const lab = labNameFromSheet(sheet.name);
  const plan: WorkbookLabPlan = {
    sheet: sheet.name,
    lab,
    labExists: false,
    people: [],
    piUsername: null,
    membersToAdd: 0,
    studentsToCreate: 0,
    studentsToUpdate: 0,
    issues,
    warnings,
    ok: false,
  };

  if (!lab || !LAB_NAME_RE.test(lab)) {
    issues.push({ line: 0, message: `sheet name '${sheet.name}' is not a usable lab name` });
    return plan;
  }
  if (sheet.rows.length > MAX_WORKBOOK_ROWS) {
    issues.push({ line: 0, message: `too many rows (${sheet.rows.length}; max ${MAX_WORKBOOK_ROWS})` });
    return plan;
  }

  const existingLab = getLabByName(lab);
  plan.labExists = !!existingLab;
  const currentMembers = new Set(
    existingLab
      ? (db()
          .prepare("SELECT student_id FROM lab_members WHERE lab_id = ?")
          .all(existingLab.id) as { student_id: number }[]).map((row) => row.student_id)
      : [],
  );
  const currentPi = existingLab?.pi_student_id
    ? ([...students.byUsername.values()].find((s) => s.id === existingLab.pi_student_id) ?? null)
    : null;

  const mapping = mapColumns(sheet.rows);
  if (!mapping) {
    issues.push({ line: 0, message: "no 'UGA ID' (username) column found in the first rows" });
    return plan;
  }
  const cell = (row: string[], column: Column): string => {
    const index = mapping.columns[column];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const seen = new Set<string>();
  for (let r = mapping.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const line = r + 1; // as displayed in Excel
    const username = cell(row, "username").toLowerCase();
    const email = cell(row, "email").toLowerCase();
    const firstName = cell(row, "firstName");
    const lastName = cell(row, "lastName");
    const degree = normalizeDegree(cell(row, "degree"));
    if (!username && !email && !firstName && !lastName) continue; // blank / spacer row

    if (!username) {
      issues.push({ line, message: "missing UGA ID" });
      continue;
    }
    if (!USERNAME_RE.test(username)) {
      issues.push({ line, message: `invalid UGA ID '${username}' (letters, digits, - and _ only)` });
      continue;
    }
    if (seen.has(username)) {
      issues.push({ line, message: `'${username}' appears twice on this sheet` });
      continue;
    }
    seen.add(username);
    if (email && !EMAIL_RE.test(email)) {
      issues.push({ line, message: `invalid email '${email}'` });
      continue;
    }
    if (!email) warnings.push(`${username} has no email — they cannot be sent credentials`);

    const isPi = isFacultyDegree(degree) && plan.piUsername === null;
    if (isFacultyDegree(degree) && !isPi) {
      warnings.push(`${username} is also marked Faculty — added as an ordinary member (the PI is ${plan.piUsername})`);
    }
    const existing = students.byUsername.get(username) ?? students.byStudentId.get(username);
    const person: WorkbookPerson = {
      line,
      username,
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      degree,
      isPi,
      action: "unchanged",
      alreadyMember: !!existing && currentMembers.has(existing.id),
    };
    person.action = personAction(existing, person);
    if (isPi) {
      plan.piUsername = username;
      if (currentPi && currentPi.username !== username) {
        issues.push({
          line,
          message: `lab '${lab}' already has PI '${currentPi.username}' — a PI login cannot be changed after provisioning`,
        });
      }
    }
    plan.people.push(person);
  }

  if (plan.people.length === 0 && issues.length === 0) {
    issues.push({ line: 0, message: "no people found on this sheet" });
  }
  if (plan.piUsername === null && plan.people.length > 0 && !currentPi) {
    warnings.push("no row is marked Faculty — the lab is created without a PI login");
  }
  plan.studentsToCreate = plan.people.filter((p) => p.action === "create").length;
  plan.studentsToUpdate = plan.people.filter((p) => p.action === "update").length;
  plan.membersToAdd = plan.people.filter((p) => !p.alreadyMember).length;
  plan.ok = issues.length === 0;
  return plan;
}

const MAX_CELL_CHARS = 200;
const MAX_COLS = 64;

/**
 * Coerce whatever the browser posted into a bounded grid of trimmed strings. The parsed workbook
 * arrives as plain JSON over a Server Action, so every shape and size assumption is re-checked here
 * before any of it is read as roster data.
 */
export function normalizeWorkbookSheets(input: unknown): WorkbookSheet[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_WORKBOOK_SHEETS).map((sheet) => {
    const raw = (sheet ?? {}) as { name?: unknown; rows?: unknown };
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    return {
      name: String(raw.name ?? "").trim().slice(0, MAX_CELL_CHARS),
      // One past the limit, so an oversized sheet is reported as such instead of silently truncated.
      rows: rows.slice(0, MAX_WORKBOOK_ROWS + 1).map((row) =>
        (Array.isArray(row) ? row : []).slice(0, MAX_COLS).map((cell) =>
          typeof cell === "string" || typeof cell === "number"
            ? String(cell).trim().slice(0, MAX_CELL_CHARS)
            : "",
        ),
      ),
    };
  });
}

/** Compute what a workbook would change, reading (never writing) the current DB state. */
export function planWorkbookImport(sheets: WorkbookSheet[]): WorkbookImportPlan {
  const issues: string[] = [];
  const list = normalizeWorkbookSheets(sheets);
  if (list.length === 0) issues.push("the workbook has no sheets");
  if (list.length > MAX_WORKBOOK_SHEETS) {
    return { labs: [], labsToCreate: 0, studentsToCreate: 0, studentsToUpdate: 0, membersToAdd: 0,
      issues: [`too many sheets (${list.length}; max ${MAX_WORKBOOK_SHEETS})`], ok: false };
  }

  const byUsername = new Map<string, DbStudent>();
  const byStudentId = new Map<string, DbStudent>();
  for (const s of db()
    .prepare("SELECT id, student_id, username, email, name, first_name, last_name, degree FROM students")
    .all() as DbStudent[]) {
    byUsername.set(s.username, s);
    if (s.student_id) byStudentId.set(s.student_id, s);
  }

  const labs = list.map((sheet) => planSheet(sheet, { byUsername, byStudentId }));

  // Two tabs cannot map onto the same lab; that would silently merge two rosters.
  const byLabName = new Map<string, string>();
  for (const plan of labs) {
    if (!plan.lab) continue;
    const other = byLabName.get(plan.lab);
    if (other && other !== plan.sheet) {
      issues.push(`sheets '${other}' and '${plan.sheet}' both map to lab '${plan.lab}'`);
      plan.ok = false;
    } else {
      byLabName.set(plan.lab, plan.sheet);
    }
  }

  return {
    labs,
    labsToCreate: labs.filter((l) => !l.labExists && l.ok).length,
    studentsToCreate: labs.reduce((n, l) => n + l.studentsToCreate, 0),
    studentsToUpdate: labs.reduce((n, l) => n + l.studentsToUpdate, 0),
    membersToAdd: labs.reduce((n, l) => n + l.membersToAdd, 0),
    issues,
    ok: issues.length === 0 && labs.length > 0 && labs.every((l) => l.ok),
  };
}

// ---------------------------------------------------------------------------- applying

/**
 * Apply a workbook import: create any missing lab, designate its PI, and enroll every person listed.
 * The plan is re-derived here — a client-supplied plan is never trusted — and the import refuses to
 * run unless every sheet is committable. Existing labs, members, and unchanged people are left
 * alone, so re-importing the same workbook is a no-op.
 */
export async function applyWorkbookImport(
  sheets: WorkbookSheet[],
  actor?: string,
): Promise<WorkbookImportResult> {
  const plan = planWorkbookImport(sheets);
  if (!plan.ok) {
    const first =
      plan.issues[0] ??
      plan.labs.flatMap((l) => l.issues.map((i) => `${l.sheet}${i.line ? ` line ${i.line}` : ""}: ${i.message}`))[0];
    throw new Error(`Workbook not importable${first ? ` — first problem: ${first}` : ""}`);
  }

  const result: WorkbookImportResult = {
    labsCreated: [],
    labsUpdated: [],
    pisSet: 0,
    studentsCreated: 0,
    studentsUpdated: 0,
    membershipsAdded: 0,
    provisioned: 0,
  };

  for (const sheetPlan of plan.labs) {
    const existing = getLabByName(sheetPlan.lab);
    const pi = sheetPlan.people.find((p) => p.isPi) ?? null;
    const lab =
      existing ??
      createLab({
        name: sheetPlan.lab,
        piName: composeName(pi?.firstName, pi?.lastName) ?? undefined,
        piEmail: pi?.email ?? undefined,
        actor,
      });
    if (existing) result.labsUpdated.push(lab.name);
    else result.labsCreated.push(lab.name);

    for (const person of sheetPlan.people) {
      const input: StudentInput = {
        username: person.username,
        email: person.email ?? undefined,
        firstName: person.firstName ?? undefined,
        lastName: person.lastName ?? undefined,
        degree: person.degree ?? undefined,
        studentId: person.username, // the UGA ID is both the login and the institutional ID
      };
      if (person.action === "create") result.studentsCreated += 1;

      if (person.isPi) {
        // ensurePiAccess writes the PI's details, records the protected membership, and provisions
        // them on every placement the lab already has.
        const res = await ensurePiAccess(lab.id, input, actor);
        result.pisSet += 1;
        if (!person.alreadyMember) result.membershipsAdded += 1;
        result.provisioned += res.provisioned.length;
        if (person.action === "update") result.studentsUpdated += 1;
        continue;
      }

      const record = findOrCreateStudent(input);
      if (person.action === "update" && updateStudentProfile(record.id, input)) result.studentsUpdated += 1;
      if (person.alreadyMember) continue;
      const res = await addStudentToLab(lab.id, input, actor);
      result.membershipsAdded += 1;
      result.provisioned += res.provisioned.length;
    }
  }

  audit(actor, "lab.workbook_import", plan.labs.map((l) => l.lab).join(","), JSON.stringify(result));
  return result;
}

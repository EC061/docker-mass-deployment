/**
 * People's names and academic standing.
 *
 * Names are stored as separate `first_name` / `last_name` columns (that is how rosters arrive from
 * the department spreadsheet), with the legacy single `name` column kept in sync as the composed
 * display form so existing {name} templates and screens keep working.
 *
 * `degree` is the roster's "MS or PhD" column: PhD / MS / Faculty and friends. A Faculty row is how
 * a workbook sheet designates its PI; every other value is informational and only surfaces in email
 * templates as {degree}.
 */

/** Canonical degree spellings. Anything unrecognized is kept verbatim (trimmed) rather than dropped. */
export const FACULTY_DEGREE = "Faculty";

const DEGREE_ALIASES: Record<string, string> = {
  faculty: FACULTY_DEGREE,
  pi: FACULTY_DEGREE,
  prof: FACULTY_DEGREE,
  professor: FACULTY_DEGREE,
  instructor: FACULTY_DEGREE,
  phd: "PhD",
  "ph.d": "PhD",
  "ph.d.": "PhD",
  doctoral: "PhD",
  ms: "MS",
  "m.s": "MS",
  "m.s.": "MS",
  msc: "MS",
  master: "MS",
  masters: "MS",
  "master's": "MS",
  postdoc: "Postdoc",
  "post-doc": "Postdoc",
  postdoctoral: "Postdoc",
  bs: "Undergraduate",
  ba: "Undergraduate",
  undergrad: "Undergraduate",
  undergraduate: "Undergraduate",
  staff: "Staff",
  student: "Student",
};

/** Degrees offered in the UI pickers. Free-form values from an import are still accepted. */
export const DEGREE_OPTIONS = ["PhD", "MS", "Undergraduate", "Postdoc", "Staff", FACULTY_DEGREE];

const DEGREE_RE = /^[A-Za-z][A-Za-z0-9 .'+/-]{0,31}$/;

/**
 * Normalize a roster "MS or PhD" cell to its canonical spelling ("Phd" -> "PhD", "faculty" ->
 * "Faculty"). Unknown but plausible values are trimmed and kept; blank or implausible values
 * (too long / not starting with a letter) become null.
 */
export function normalizeDegree(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const alias = DEGREE_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  return DEGREE_RE.test(value) ? value : null;
}

/** Whether a degree designates the lab's PI (the workbook marks the PI with "Faculty"). */
export function isFacultyDegree(degree: string | null | undefined): boolean {
  return normalizeDegree(degree) === FACULTY_DEGREE;
}

/** Compose the display name stored in `students.name` / `labs.pi_name`. Null when both parts are blank. */
export function composeName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const full = [(firstName ?? "").trim(), (lastName ?? "").trim()].filter(Boolean).join(" ");
  return full || null;
}

/**
 * Split a legacy single-field name into first + last: everything before the final space is the first
 * name (so "Dr. Jane Smith" -> "Dr. Jane" + "Smith"), a single token is the first name only.
 */
export function splitFullName(full: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const value = (full ?? "").trim().replace(/\s+/g, " ");
  if (!value) return { firstName: null, lastName: null };
  const cut = value.lastIndexOf(" ");
  if (cut < 0) return { firstName: value, lastName: null };
  return { firstName: value.slice(0, cut), lastName: value.slice(cut + 1) };
}

export interface PersonName {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  username?: string | null;
}

/** The {first_name}/{last_name}/{name} template values for a person, with sensible fallbacks. */
export function nameVars(person: PersonName): { name: string; first_name: string; last_name: string } {
  const split = splitFullName(person.name);
  const first = (person.first_name ?? "").trim() || split.firstName || "";
  const last = (person.last_name ?? "").trim() || split.lastName || "";
  const name = composeName(first, last) ?? (person.name ?? "").trim() ?? "";
  return {
    name: name || (person.username ?? "").trim(),
    first_name: first,
    last_name: last,
  };
}

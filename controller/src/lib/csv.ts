/**
 * CSV import with a configurable column mapping (replaces the old eLC-specific parser).
 * The admin maps CSV columns to username/email/name/studentId; we validate before committing.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Minimal RFC4180-ish parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // ignore; newline handled on \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
  return { headers, rows };
}

export interface ColumnMapping {
  username: string;
  email?: string;
  name?: string;
  studentId?: string;
}

export interface ImportRow {
  username: string;
  email?: string;
  name?: string;
  studentId?: string;
  issues: string[];
}

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** A row's fields before validation — what the browser sends to the import action. */
export interface RawImportRow {
  username?: string;
  email?: string;
  name?: string;
  studentId?: string;
}

/**
 * Validate + normalize already-extracted rows (username lowercased/trimmed, intra-batch dedup,
 * optional email-required check). Shared by applyMapping (browser preview) and the import server
 * action, so the server re-validates exactly what the browser showed — the client is never trusted.
 */
export function validateImportRows(
  rows: RawImportRow[],
  opts: { requireEmail?: boolean } = {},
): ImportRow[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const issues: string[] = [];
    const username = (r.username ?? "").trim().toLowerCase();
    const email = r.email?.trim() || undefined;
    const name = r.name?.trim() || undefined;
    const studentId = r.studentId?.trim() || undefined;

    if (!username) issues.push("missing username");
    else if (!USERNAME_RE.test(username)) issues.push("invalid username");
    else if (seen.has(username)) issues.push("duplicate username in file");
    if (username) seen.add(username);
    if (opts.requireEmail && !email) issues.push("missing email");

    return { username, email, name, studentId, issues };
  });
}

export function applyMapping(parsed: ParsedCsv, mapping: ColumnMapping): ImportRow[] {
  const raw = parsed.rows.map((r) => ({
    username: r[mapping.username] ?? "",
    email: mapping.email ? (r[mapping.email] ?? "") : undefined,
    name: mapping.name ? (r[mapping.name] ?? "") : undefined,
    studentId: mapping.studentId ? (r[mapping.studentId] ?? "") : undefined,
  }));
  return validateImportRows(raw, { requireEmail: !!mapping.email });
}

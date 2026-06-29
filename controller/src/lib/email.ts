/**
 * Email normalization for storage + lookup. Addresses are treated case-insensitively and trimmed so
 * a stray uppercase letter or surrounding whitespace can't create a duplicate account or slip past a
 * uniqueness/login check. Blank input normalizes to null (no email on file).
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const e = email.trim().toLowerCase();
  return e === "" ? null : e;
}

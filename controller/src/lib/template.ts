/**
 * Tiny {placeholder} substitution shared by the mailer, GPU/welcome templates, and announcements.
 * Kept in its own module (rather than in mailer.ts) so callers can render templates without pulling
 * in nodemailer/SMTP, and so tests that mock the mailer still get the real renderer.
 */

/**
 * Substitute {placeholder} tokens in a template. Unknown tokens are left untouched so a typo in the
 * admin's template is visible rather than silently dropped. Values are coerced to strings; a
 * null/undefined value renders as an empty string.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : whole,
  );
}

/** Remove the signature used by older built-in templates before the universal signature existed. */
export function stripLegacyEmailSignature(text: string): string {
  return text.replace(/\n*\s*—\s*Lab Manager\s*$/i, "").trimEnd();
}

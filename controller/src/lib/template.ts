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

/** Convert a legacy HTML signature to plain text during the settings migration. */
export function legacySignatureHtmlToText(html: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi, "\n$2\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return text
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
      if (entity[0] !== "#") return namedEntities[entity.toLowerCase()] ?? whole;
      const hex = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

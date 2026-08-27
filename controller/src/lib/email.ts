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

/** A From header split into its display name and address parts. */
export interface EmailFrom {
  name: string;
  address: string;
}

/**
 * The From header recipients actually see. The address always comes from the SMTP config that
 * delivers the message (providers reject a From they don't own), and the display name in front of
 * it is the configured sender name — otherwise a mail client shows the bare address twice, as
 * "labs@uga.edu <labs@uga.edu>". A From that already carries its own display name keeps it.
 */
export function resolveEmailFrom(senderName: string, smtpFrom: string): EmailFrom {
  const match = /^\s*(.*?)\s*<\s*([^>]*)\s*>\s*$/.exec(smtpFrom);
  const address = (match ? match[2] : smtpFrom).trim();
  const configured = (match?.[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  return { name: configured || senderName.trim(), address };
}

/** Render an EmailFrom as an RFC 5322 header value, quoting the display name only when it needs it. */
export function formatEmailFrom(from: EmailFrom): string {
  if (!from.name) return from.address;
  const name = /["(),:;<>@[\\\]]/.test(from.name)
    ? `"${from.name.replace(/(["\\])/g, "\\$1")}"`
    : from.name;
  return `${name} <${from.address}>`;
}

/** Random initial-password generation, in its own module to avoid lab/student/placement import cycles. */

import { randomBytes } from "node:crypto";

// Unambiguous alphabet (no 0/O/1/l/I) so emailed passwords are easy to type.
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 14): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  return out;
}

/**
 * Transparent encryption-at-rest for stored credential strings (SMTP/WebDAV passwords) — M-05.
 *
 * AES-256-GCM with a key derived from SESSION_SECRET via scrypt, so no extra mandatory env var is
 * introduced (rotating SESSION_SECRET invalidates stored secrets, which is acceptable and noted in
 * the README). Ciphertext is tagged with a version prefix; decryptSecret() passes through any value
 * that isn't in that format, so pre-existing plaintext rows keep working and are re-encrypted the
 * next time they're saved.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "./env";

const PREFIX = "enc:v1:";
const SALT = "lab-manager:secrets:v1"; // fixed salt: the master secret already carries the entropy.

let _key: Buffer | null = null;
function key(): Buffer {
  if (!_key) _key = scryptSync(env.sessionSecret, SALT, 32);
  return _key;
}

/** Encrypt a secret string to "enc:v1:<iv>:<tag>:<ct>" (all base64). Empty string passes through. */
export function encryptSecret(plain: string): string {
  if (plain === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a value produced by encryptSecret. A value not in that format is returned unchanged. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext or empty
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) return stored;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return ""; // wrong key / tampered — fail closed to empty rather than leak or crash
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

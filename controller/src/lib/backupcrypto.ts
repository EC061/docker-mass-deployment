/**
 * Encryption + integrity for controller DB backups uploaded to WebDAV.
 *
 * Keyed on BACKUP_KEY, deliberately SEPARATE from SESSION_SECRET: a leaked session secret must not
 * decrypt off-site backups, and rotating one must not break the other. AES-256-GCM; the auth tag
 * doubles as an integrity check, so a tampered or truncated backup fails to restore rather than
 * silently loading corrupt data.
 *
 * Envelope: MAGIC(6) | iv(12) | tag(16) | ciphertext. When BACKUP_KEY is unset, backups are written
 * as-is (plaintext, the legacy format) and decryptBackup() passes any non-enveloped blob through, so
 * existing backups keep restoring after the key is introduced.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "./env";

const MAGIC = Buffer.from("LMBK1\0", "latin1"); // 6 bytes: identifies our encrypted envelope
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = "lab-manager:backup:v1"; // fixed salt; BACKUP_KEY carries the entropy

let _key: Buffer | null = null;
function key(): Buffer {
  if (!_key) _key = scryptSync(env.backupKey, SALT, 32);
  return _key;
}

export function backupEncryptionEnabled(): boolean {
  return env.backupKey !== "";
}

/** Encrypt a backup blob when BACKUP_KEY is set; otherwise return it unchanged (legacy plaintext). */
export function maybeEncryptBackup(plain: Buffer): Buffer {
  if (!backupEncryptionEnabled()) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

/** True if `data` is one of our encrypted envelopes (vs a legacy plaintext backup). */
export function isEncryptedBackup(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Decrypt a downloaded backup. A legacy (non-enveloped) blob is returned unchanged. An enveloped
 * blob requires BACKUP_KEY and a matching auth tag — a wrong key or any tampering throws.
 */
export function decryptBackup(data: Buffer): Buffer {
  if (!isEncryptedBackup(data)) return data;
  if (!backupEncryptionEnabled()) {
    throw new Error("backup is encrypted but BACKUP_KEY is not set");
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = data.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = data.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on a bad tag
}

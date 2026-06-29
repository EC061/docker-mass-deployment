/**
 * Admin authentication. Registration is gated by SIGNUP_TOKEN; thereafter local accounts with
 * bcrypt-hashed passwords. Sessions are signed JWTs stored in an httpOnly cookie.
 */

import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { normalizeEmail } from "./email";
import { env } from "./env";

const COOKIE = "lab_session";
const SESSION_TTL = "24h"; // shortened from 7d (H-07); revocation is also enforced via token_version
const SESSION_MAX_AGE = 60 * 60 * 24;
const BCRYPT_COST = 12; // L-05: raise from 10
const MIN_PASSWORD_LEN = 12; // L-05: enforced server-side, not just in the form

// A bcrypt hash of a random string, compared against when no admin row matches, so login timing
// doesn't reveal whether an email exists (L-03).
const DUMMY_HASH = bcrypt.hashSync("no-such-user-placeholder", BCRYPT_COST);

/** Constant-time string comparison for shared secrets (L-01). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Lazily derived so importing this module doesn't read env at build time.
let _secret: Uint8Array | null = null;
function secretKey(): Uint8Array {
  if (!_secret) _secret = new TextEncoder().encode(env.sessionSecret);
  return _secret;
}

export interface Admin {
  id: number;
  name: string;
  email: string;
}

export interface SessionClaims {
  sub: string; // admin id
  email: string;
  name: string;
  ver: number; // token_version at issue time; checked against the DB to allow revocation
}

/** token_version for an admin, or 0 if the row/column is absent. */
function tokenVersion(adminId: number): number {
  const row = db().prepare("SELECT token_version FROM admins WHERE id = ?").get(adminId) as
    | { token_version: number }
    | undefined;
  return row?.token_version ?? 0;
}

export async function createAdmin(name: string, email: string, password: string, signupToken: string): Promise<Admin> {
  if (!safeEqual(signupToken, env.signupToken)) {
    throw new Error("Invalid signup token");
  }
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const normEmail = normalizeEmail(email);
  if (!normEmail) throw new Error("A valid email is required");
  const existing = db().prepare("SELECT id FROM admins WHERE email = ?").get(normEmail);
  if (existing) throw new Error("An admin with that email already exists");
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const info = db()
    .prepare("INSERT INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(name, normEmail, hash, Date.now());
  return { id: Number(info.lastInsertRowid), name, email: normEmail };
}

export async function verifyLogin(email: string, password: string): Promise<Admin | null> {
  const row = db().prepare("SELECT * FROM admins WHERE email = ?").get(normalizeEmail(email)) as any;
  // Always run a bcrypt comparison (against a dummy hash when the email is unknown) so response
  // timing doesn't reveal whether an admin exists (L-03).
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return null;
  // A disabled admin cannot authenticate (H-07).
  if (row.is_active !== undefined && row.is_active !== 1) return null;
  return { id: row.id, name: row.name, email: row.email };
}

export async function issueSession(admin: Admin): Promise<string> {
  return new SignJWT({ email: admin.email, name: admin.name, ver: tokenVersion(admin.id) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(admin.id))
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secretKey());
}

export async function setSessionCookie(admin: Admin): Promise<void> {
  const token = await issueSession(admin);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

/** Invalidate every outstanding session for an admin by bumping token_version (logout-all, H-07). */
export function logoutAllSessions(adminId: number): void {
  db().prepare("UPDATE admins SET token_version = token_version + 1 WHERE id = ?").run(adminId);
}

/** Enable/disable an admin. A disabled admin cannot log in and existing sessions are rejected. */
export function setAdminActive(adminId: number, active: boolean): void {
  db().prepare("UPDATE admins SET is_active = ? WHERE id = ?").run(active ? 1 : 0, adminId);
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function currentAdmin(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      ver: typeof payload.ver === "number" ? payload.ver : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Authoritative authorization gate for privileged Server Actions. Unlike currentAdmin() (which only
 * verifies the JWT and never throws), this re-validates the subject against the admins table and
 * rejects when the admin is missing, disabled, or carrying a stale token_version — then returns the
 * verified Admin. Call it as the FIRST line of every mutating action. redirect() throws
 * NEXT_REDIRECT, so the action body cannot proceed past an unauthenticated/invalid caller.
 */
export async function requireAdmin(): Promise<Admin> {
  const claims = await currentAdmin();
  if (!claims) redirect("/login");
  const row = db()
    .prepare("SELECT id, name, email, is_active, token_version FROM admins WHERE id = ?")
    .get(Number(claims.sub)) as
    | { id: number; name: string; email: string; is_active: number; token_version: number }
    | undefined;
  if (!row || row.is_active !== 1 || row.token_version !== claims.ver) {
    await clearSessionCookie();
    redirect("/login");
  }
  return { id: row.id, name: row.name, email: row.email };
}

/**
 * Page-render authorization gate. Like requireAdmin() it re-validates the JWT subject against the
 * admins table (so a disabled or token-rotated admin can't keep viewing pages on an old cookie), but
 * it must NOT mutate cookies — clearing a cookie is illegal during a Server Component render — so it
 * only redirects. Call it at the top of the authed layout; mutations still go through requireAdmin().
 */
export async function requireAdminPage(): Promise<Admin> {
  const claims = await currentAdmin();
  if (!claims) redirect("/login");
  const row = db()
    .prepare("SELECT id, name, email, is_active, token_version FROM admins WHERE id = ?")
    .get(Number(claims.sub)) as
    | { id: number; name: string; email: string; is_active: number; token_version: number }
    | undefined;
  if (!row || row.is_active !== 1 || row.token_version !== claims.ver) redirect("/login");
  return { id: row.id, name: row.name, email: row.email };
}

export function adminCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  return row.n;
}

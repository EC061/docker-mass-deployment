/**
 * Admin authentication. Registration is gated by SIGNUP_TOKEN; thereafter local accounts with
 * bcrypt-hashed passwords. Sessions are signed JWTs stored in an httpOnly cookie.
 */

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { env } from "./env";

const COOKIE = "lab_session";
const SESSION_TTL = "7d";

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
  if (signupToken !== env.signupToken) {
    throw new Error("Invalid signup token");
  }
  const existing = db().prepare("SELECT id FROM admins WHERE email = ?").get(email);
  if (existing) throw new Error("An admin with that email already exists");
  const hash = await bcrypt.hash(password, 10);
  const info = db()
    .prepare("INSERT INTO admins (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(name, email, hash, Date.now());
  return { id: Number(info.lastInsertRowid), name, email };
}

export async function verifyLogin(email: string, password: string): Promise<Admin | null> {
  const row = db().prepare("SELECT * FROM admins WHERE email = ?").get(email) as any;
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
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
    maxAge: 60 * 60 * 24 * 7,
  });
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

export function adminCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  return row.n;
}

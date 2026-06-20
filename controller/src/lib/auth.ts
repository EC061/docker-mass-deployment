/**
 * Admin authentication. Registration is gated by SIGNUP_TOKEN; thereafter local accounts with
 * bcrypt-hashed passwords. Sessions are signed JWTs stored in an httpOnly cookie.
 */

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
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
  return new SignJWT({ email: admin.email, name: admin.name })
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
    sameSite: "lax",
    secure: env.isProd,
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
    const { payload } = await jwtVerify(token, secretKey());
    return { sub: payload.sub as string, email: payload.email as string, name: payload.name as string };
  } catch {
    return null;
  }
}

export function adminCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  return row.n;
}

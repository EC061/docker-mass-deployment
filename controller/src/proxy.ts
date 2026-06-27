/**
 * Defense-in-depth auth gate. Server Actions compile to POST endpoints that do NOT pass through the
 * page layout, so the layout's redirect is not a real gate — requireAdmin() (in lib/auth.ts) is the
 * authority and re-checks the DB. This proxy runs on the edge (no DB access there), so it only
 * blocks requests with a missing or unverifiable session cookie early, before they reach an action.
 *
 * The matcher excludes the public auth routes, Next internals, and the /agent WebSocket upgrade
 * (handled by the custom server.ts before Next routing).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

export const config = {
  matcher: ["/((?!login|signup|_next/static|_next/image|favicon.ico|agent).*)"],
};

export async function proxy(req: NextRequest) {
  const token = req.cookies.get("lab_session")?.value;
  const loginUrl = new URL("/login", req.url);
  if (!token) return NextResponse.redirect(loginUrl);
  const secret = process.env.SESSION_SECRET;
  // env.ts fails closed in every environment (see required()), so a missing secret here means a
  // misconfigured deploy — refuse rather than fall back to a guessable key.
  if (!secret) return NextResponse.redirect(loginUrl);
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
  } catch {
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

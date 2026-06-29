/**
 * One-time, short-lived server-side flash store (M-07). Used to surface a freshly generated student
 * password to the admin exactly once without ever putting the cleartext in a redirect URL, browser
 * history, or access logs. The redirect carries only an opaque random id; the value is read and
 * deleted on the next page render. Process-local (single long-lived controller process).
 */

import { randomBytes } from "node:crypto";

interface Entry {
  value: string;
  expires: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 1000;

/** Drop expired entries so an unread flash (its redirect never followed) can't linger forever. */
function prune(now: number): void {
  for (const [id, e] of store) {
    if (now > e.expires) store.delete(id);
  }
}

/** Stash a value; returns an opaque id to put in the redirect. */
export function putFlash(value: string): string {
  const now = Date.now();
  prune(now);
  // Hard cap as a backstop against unbounded growth (evict oldest-inserted first).
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const id = randomBytes(16).toString("hex");
  store.set(id, { value, expires: now + TTL_MS });
  return id;
}

/** Read and delete a flashed value, or null if missing/expired. */
export function takeFlash(id: string): string | null {
  const e = store.get(id);
  if (!e) return null;
  store.delete(id);
  if (Date.now() > e.expires) return null;
  return e.value;
}

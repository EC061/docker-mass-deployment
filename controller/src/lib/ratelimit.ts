/**
 * In-memory per-key rate limiter (token bucket) for unauthenticated endpoints — login and signup.
 * The controller is a single long-lived process, so process-local state is sufficient and avoids a
 * dependency; it resets on restart, which is acceptable for brute-force throttling (H-02).
 */

import { headers } from "next/headers";

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Sustained refill rate, tokens per second. */
  ratePerSec: number;
  /** Bucket capacity (max burst). */
  burst: number;
}

/** Consume one token for `key`. Returns true if allowed, false if the bucket is empty. */
export function consume(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: opts.burst, last: now };
  b.tokens = Math.min(opts.burst, b.tokens + ((now - b.last) / 1000) * opts.ratePerSec);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/** Best-effort client IP from common proxy headers; falls back to a constant bucket. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "unknown";
}

// Tuned for interactive auth: a handful of attempts, then throttled. ~5 burst, refilling 1 / 12s.
export const AUTH_LIMIT: RateLimitOptions = { ratePerSec: 1 / 12, burst: 5 };

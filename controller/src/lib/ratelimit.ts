/**
 * In-memory per-key rate limiter (token bucket) for unauthenticated endpoints — login and signup.
 * The controller is a single long-lived process, so process-local state is sufficient and avoids a
 * dependency; it resets on restart, which is acceptable for brute-force throttling (H-02).
 */

import { headers } from "next/headers";
import { env } from "./env";

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();
// Bound the map so a flood of distinct keys can't grow it without limit; once over the cap we evict
// idle buckets (and, failing that, the oldest) so memory stays bounded (M-02-ish for the auth path).
const MAX_BUCKETS = 10_000;
const IDLE_MS = 60 * 60 * 1000;

function prune(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [k, b] of buckets) {
    if (now - b.last > IDLE_MS) buckets.delete(k);
  }
  // Still over (all buckets recently active): drop oldest-inserted until under the cap.
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

export interface RateLimitOptions {
  /** Sustained refill rate, tokens per second. */
  ratePerSec: number;
  /** Bucket capacity (max burst). */
  burst: number;
}

/** Consume one token for `key`. Returns true if allowed, false if the bucket is empty. */
export function consume(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  prune(now);
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

/**
 * Client IP for rate-limit keying. X-Forwarded-* headers are client-controlled unless we sit behind
 * a trusted reverse proxy (env.trustProxy), so when untrusted we bucket all unauthenticated traffic
 * together rather than honor a spoofable header. When trusted, a single proxy appends the real peer
 * as the LAST hop of X-Forwarded-For (client-supplied entries are to its left), so we take that.
 */
export async function clientIp(): Promise<string> {
  if (!env.trustProxy) return "untrusted-proxy"; // single shared bucket; never trust spoofable XFF
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

// Tuned for interactive auth: a handful of attempts, then throttled. ~5 burst, refilling 1 / 12s.
export const AUTH_LIMIT: RateLimitOptions = { ratePerSec: 1 / 12, burst: 5 };

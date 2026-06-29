"use client";

/**
 * While at least one per-student usage scan is in flight, poll the server so the page's "scanning…"
 * indicators clear (and the fresh numbers appear) on their own — scan completion is reported async
 * by the agent's heartbeat, so without this the indicator would stick until a manual reload.
 *
 * The post-scan heartbeat writes the fresh per-student samples and advances usage_scanned_at in the
 * same ingest call, so the refresh that observes `scanPending` flip to false renders the up-to-date
 * numbers too — there is no window where the indicator clears but the table is still stale. We poll
 * fairly tightly and also refresh immediately on activation so the very first heartbeat after a scan
 * is picked up promptly.
 *
 * Renders nothing; it just drives router.refresh() while `active`.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ScanAutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    router.refresh(); // pick up a heartbeat that may have landed between renders
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}

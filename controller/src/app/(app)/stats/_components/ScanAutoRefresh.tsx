"use client";

/**
 * While at least one per-student usage scan is in flight, poll the server so the page's "scanning…"
 * indicators clear (and fresh numbers appear) on their own — scan completion is reported async by
 * the agent's heartbeat, so without this the indicator would stick until a manual reload.
 *
 * Renders nothing; it just drives router.refresh() on an interval while `active`.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ScanAutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}

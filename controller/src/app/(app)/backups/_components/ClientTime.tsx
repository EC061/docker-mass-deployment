"use client";

import { useSyncExternalStore } from "react";

// `false` on the server and during the first hydration render, `true` thereafter — the
// useSyncExternalStore pattern keeps hydration consistent without a setState-in-effect.
const subscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * Render an epoch-ms timestamp in the viewer's browser timezone, plus — when it differs — the same
 * instant in the configured schedule timezone. toLocaleString() formats in the *runtime's* tz, so
 * this must run in the browser: rendering on the server (as the old version did) pinned the display
 * to the server's tz, and suppressHydrationWarning then froze that wrong value in the DOM. We format
 * only after hydration and show a placeholder until then, which also sidesteps a hydration mismatch.
 */
export function ClientTime({ ts, tz }: { ts: number; tz?: string }) {
  const hydrated = useHydrated();

  if (!ts) return <span>never</span>;
  if (!hydrated) return <span className="text-muted-foreground">…</span>;

  const local = new Date(ts).toLocaleString();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let inTz: string | null = null;
  // Only add the schedule-tz reading when it actually differs from the viewer's tz (no point showing
  // the same time twice for an admin who lives in the configured zone).
  if (tz && tz !== browserTz) {
    try {
      inTz = new Date(ts).toLocaleString(undefined, { timeZone: tz });
    } catch {
      inTz = null; // unknown tz name -> just show the browser-local time
    }
  }

  return (
    <span>
      {local}
      {inTz && (
        <span className="text-muted-foreground">
          {" · "}
          {inTz} ({tz})
        </span>
      )}
    </span>
  );
}

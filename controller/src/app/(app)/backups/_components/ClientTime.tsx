"use client";

/**
 * Render an epoch-ms timestamp in the viewer's local timezone/locale. Formatting differs between the
 * server (its tz) and the browser, so suppressHydrationWarning avoids a spurious mismatch warning.
 */
export function ClientTime({ ts }: { ts: number }) {
  if (!ts) return <span>never</span>;
  return <span suppressHydrationWarning>{new Date(ts).toLocaleString()}</span>;
}

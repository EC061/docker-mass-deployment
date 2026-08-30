/** Byte size of each quota-input unit, shared with the amount+unit quota forms and their server
 * actions so the two always agree on what "1 GiB" means. These are binary units and are labelled as
 * such: the agent, ZFS, mergerfs and `labquota` all work in powers of 1024, so calling 1024**3 a
 * "GB" made every quota in the UI disagree with every number the node reports. */
export const QUOTA_UNIT_BYTES = { MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 } as const;
export type QuotaUnit = keyof typeof QUOTA_UNIT_BYTES;

/** Pick the largest whole unit (MiB/GiB/TiB) for a byte quota, to pre-fill an editable amount+unit
 * input pair. Rounded to 3 decimals so re-editing an already-set quota doesn't show float noise. */
export function bytesToQuotaInput(bytes: number): { amount: number; unit: QuotaUnit } {
  const unit: QuotaUnit = bytes >= QUOTA_UNIT_BYTES.TiB ? "TiB" : bytes >= QUOTA_UNIT_BYTES.GiB ? "GiB" : "MiB";
  return { amount: Math.round((bytes / QUOTA_UNIT_BYTES[unit]) * 1000) / 1000, unit };
}

/** The single byte formatter for the whole UI. Binary units, because every byte count in this
 * product comes from ZFS/mergerfs and is a power of 1024. Do not hand-copy this ladder into a page:
 * a copy that dropped "MiB" silently rendered every size 1024x too large on the node storage page. */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Compact duration for a seconds count, e.g. 45s / 12m / 3h 20m / 2d 5h. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ""}`;
  }
  const h = Math.floor((s % 86400) / 3600);
  return `${Math.floor(s / 86400)}d${h ? ` ${h}h` : ""}`;
}

export function pct(used: number, quota: number | null | undefined): number | null {
  if (!quota || quota <= 0) return null;
  return Math.min(100, Math.round((used / quota) * 100));
}

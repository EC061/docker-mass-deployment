/** Shared parsing/aggregation for generalized node storage telemetry. */

export interface PoolTelemetry {
  name: string;
  size: number;
  alloc: number;
  free: number;
  health?: string;
  imported?: boolean;
  tiers?: string[];
}

export interface TierTotal {
  size: number;
  alloc: number;
  free: number;
}

export function parsePoolTelemetry(raw: string | null): PoolTelemetry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((p): p is PoolTelemetry => {
      if (!p || typeof p !== "object") return false;
      const row = p as Partial<PoolTelemetry>;
      return typeof row.name === "string" && typeof row.size === "number" &&
        typeof row.alloc === "number" && typeof row.free === "number";
    });
  } catch {
    return [];
  }
}

/**
 * Sum all independently-owned pools tagged for a tier. Old agents did not send `tiers`, so retain
 * their positional fast=0/cold=1 interpretation only when no entry has explicit membership.
 */
export function tierTotal(
  pools: PoolTelemetry[],
  tier: "fast" | "cold",
  legacyIndex: number,
): TierTotal | null {
  const tagged = pools.some((p) => Array.isArray(p.tiers));
  const selected = tagged
    ? pools.filter((p) => p.tiers?.includes(tier))
    : (pools[legacyIndex] ? [pools[legacyIndex]] : []);
  if (selected.length === 0) return null;
  return selected.reduce(
    (sum, p) => ({ size: sum.size + p.size, alloc: sum.alloc + p.alloc, free: sum.free + p.free }),
    { size: 0, alloc: 0, free: 0 },
  );
}

export function parseJsonObject(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

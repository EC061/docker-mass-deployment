import { describe, expect, it } from "vitest";
import { parsePoolTelemetry, tierTotal } from "../src/lib/storage";

describe("multi-pool storage telemetry", () => {
  it("aggregates every independently tagged pool in a tier", () => {
    const pools = parsePoolTelemetry(JSON.stringify([
      { name: "fast1", size: 1000, alloc: 400, free: 600, tiers: ["fast", "docker"] },
      { name: "fast2", size: 2000, alloc: 500, free: 1500, tiers: ["fast"] },
      { name: "cold1", size: 8000, alloc: 1000, free: 7000, tiers: ["cold"] },
    ]));
    expect(tierTotal(pools, "fast", 0)).toEqual({ size: 3000, alloc: 900, free: 2100 });
    expect(tierTotal(pools, "cold", 1)).toEqual({ size: 8000, alloc: 1000, free: 7000 });
  });

  it("does not count a Docker-only pool as fast lab capacity", () => {
    const pools = parsePoolTelemetry(JSON.stringify([
      { name: "docker0", size: 500, alloc: 100, free: 400, tiers: ["docker"] },
      { name: "fast1", size: 1000, alloc: 200, free: 800, tiers: ["fast"] },
    ]));
    expect(tierTotal(pools, "fast", 0)?.size).toBe(1000);
  });

  it("retains positional compatibility with old two-pool agents", () => {
    const pools = parsePoolTelemetry(JSON.stringify([
      { name: "fast", size: 1000, alloc: 100, free: 900 },
      { name: "slow", size: 2000, alloc: 200, free: 1800 },
    ]));
    expect(tierTotal(pools, "fast", 0)?.size).toBe(1000);
    expect(tierTotal(pools, "cold", 1)?.size).toBe(2000);
  });

  it("rejects malformed rows instead of producing misleading capacity", () => {
    expect(parsePoolTelemetry(JSON.stringify([
      { name: "missing-size", alloc: 1, free: 2 }, null, "bad",
    ]))).toEqual([]);
    expect(parsePoolTelemetry("not json")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { consume } from "../src/lib/ratelimit";

describe("rate limiter (H-02)", () => {
  it("allows up to the burst then blocks", () => {
    const opts = { ratePerSec: 0, burst: 3 };
    const key = "test:burst";
    expect(consume(key, opts)).toBe(true);
    expect(consume(key, opts)).toBe(true);
    expect(consume(key, opts)).toBe(true);
    expect(consume(key, opts)).toBe(false); // 4th in the window is throttled
  });

  it("keys are independent", () => {
    const opts = { ratePerSec: 0, burst: 1 };
    expect(consume("test:a", opts)).toBe(true);
    expect(consume("test:b", opts)).toBe(true);
    expect(consume("test:a", opts)).toBe(false);
  });
});

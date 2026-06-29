import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/lib/email";

describe("normalizeEmail", () => {
  it("trims + lowercases, mapping blank/missing to null", () => {
    expect(normalizeEmail("  Alice@UGA.EDU ")).toBe("alice@uga.edu");
    expect(normalizeEmail("Bob@Example.com")).toBe("bob@example.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

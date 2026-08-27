import { describe, expect, it } from "vitest";
import { formatEmailFrom, normalizeEmail, resolveEmailFrom } from "../src/lib/email";

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

describe("resolveEmailFrom", () => {
  it("labels the provider's own address with the configured sender name", () => {
    expect(resolveEmailFrom("Research Computing", "lab-notification@edwardcheng.net")).toEqual({
      name: "Research Computing",
      address: "lab-notification@edwardcheng.net",
    });
  });

  it("keeps a display name the SMTP From already carries", () => {
    expect(resolveEmailFrom("Research Computing", '"UGA Labs" <labs@uga.edu>')).toEqual({
      name: "UGA Labs",
      address: "labs@uga.edu",
    });
    expect(resolveEmailFrom("", "UGA Labs <labs@uga.edu>")).toEqual({
      name: "UGA Labs",
      address: "labs@uga.edu",
    });
  });

  it("leaves the name blank when neither side supplies one", () => {
    expect(resolveEmailFrom("  ", " labs@uga.edu ")).toEqual({ name: "", address: "labs@uga.edu" });
  });
});

describe("formatEmailFrom", () => {
  it("renders the bare address when there is no display name", () => {
    expect(formatEmailFrom({ name: "", address: "labs@uga.edu" })).toBe("labs@uga.edu");
  });

  it("quotes a display name only when RFC 5322 requires it", () => {
    expect(formatEmailFrom({ name: "Research Computing", address: "labs@uga.edu" }))
      .toBe("Research Computing <labs@uga.edu>");
    expect(formatEmailFrom({ name: "Labs, UGA", address: "labs@uga.edu" }))
      .toBe('"Labs, UGA" <labs@uga.edu>');
    expect(formatEmailFrom({ name: 'He said "hi"', address: "labs@uga.edu" }))
      .toBe('"He said \\"hi\\"" <labs@uga.edu>');
  });
});

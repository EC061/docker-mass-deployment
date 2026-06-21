import { describe, expect, it } from "vitest";

process.env.SESSION_SECRET = "test-session-secret-test-session";
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";

import { decryptSecret, encryptSecret, isEncrypted } from "../src/lib/secrets";

describe("secrets at rest (M-05)", () => {
  it("round-trips a value and marks it encrypted", () => {
    const enc = encryptSecret("hunter2");
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain("hunter2");
    expect(decryptSecret(enc)).toBe("hunter2");
  });

  it("passes through legacy plaintext (not enc-prefixed)", () => {
    expect(decryptSecret("plain-old-password")).toBe("plain-old-password");
  });

  it("empty string stays empty", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });
});

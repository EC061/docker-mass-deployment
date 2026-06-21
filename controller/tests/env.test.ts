import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env defaults", () => {
  it("dbPath falls back to ./data/controller.db", () => {
    vi.stubEnv("DB_PATH", undefined as unknown as string);
    expect(env.dbPath).toBe("./data/controller.db");
    vi.stubEnv("DB_PATH", "/custom/path.db");
    expect(env.dbPath).toBe("/custom/path.db");
  });

  it("port parses PORT and defaults to 8443", () => {
    vi.stubEnv("PORT", undefined as unknown as string);
    expect(env.port).toBe(8443);
    vi.stubEnv("PORT", "9000");
    expect(env.port).toBe(9000);
  });

  it("isProd reflects NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(env.isProd).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(env.isProd).toBe(false);
  });
});

describe("required secrets", () => {
  it("returns the explicit value when set", () => {
    vi.stubEnv("SESSION_SECRET", "explicit-secret-explicit-secret-32");
    expect(env.sessionSecret).toBe("explicit-secret-explicit-secret-32");
  });

  it("fails closed outside production — no dev fallback (H-01)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SIGNUP_TOKEN", undefined as unknown as string);
    expect(() => env.signupToken).toThrow(/Missing required env var SIGNUP_TOKEN/);
    vi.stubEnv("AGENT_TOKEN", undefined as unknown as string);
    expect(() => env.agentToken).toThrow(/Missing required env var AGENT_TOKEN/);
  });

  it("throws when a required var is missing", () => {
    vi.stubEnv("SESSION_SECRET", undefined as unknown as string);
    expect(() => env.sessionSecret).toThrow(/Missing required env var SESSION_SECRET/);
  });

  it("treats an empty string as missing", () => {
    vi.stubEnv("AGENT_TOKEN", "");
    expect(() => env.agentToken).toThrow(/AGENT_TOKEN/);
  });

  it("rejects a SESSION_SECRET shorter than 32 chars", () => {
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(() => env.sessionSecret).toThrow(/at least 32 characters/);
  });
});

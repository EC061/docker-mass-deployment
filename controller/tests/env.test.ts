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
    vi.stubEnv("SESSION_SECRET", "explicit-secret");
    expect(env.sessionSecret).toBe("explicit-secret");
  });

  it("uses the dev fallback outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SIGNUP_TOKEN", undefined as unknown as string);
    expect(env.signupToken).toBe("dev-signup-token");
    vi.stubEnv("AGENT_TOKEN", undefined as unknown as string);
    expect(env.agentToken).toBe("dev-agent-token");
  });

  it("throws in production when a required var is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", undefined as unknown as string);
    expect(() => env.sessionSecret).toThrow(/Missing required env var SESSION_SECRET/);
  });

  it("treats an empty string as missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENT_TOKEN", "");
    expect(() => env.agentToken).toThrow(/AGENT_TOKEN/);
  });
});

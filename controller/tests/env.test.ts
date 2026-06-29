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

  it("rejects a non-integer or out-of-range PORT", () => {
    vi.stubEnv("PORT", "abc");
    expect(() => env.port).toThrow(/integer/);
    vi.stubEnv("PORT", "70000");
    expect(() => env.port).toThrow(/between 1 and 65535/);
    vi.stubEnv("PORT", "0");
    expect(() => env.port).toThrow(/between 1 and 65535/);
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

  it("rejects placeholder secrets in every environment", () => {
    vi.stubEnv("SIGNUP_TOKEN", "REPLACE_WITH_RANDOM_SIGNUP_TOKEN");
    expect(() => env.signupToken).toThrow(/placeholder/);
    vi.stubEnv("AGENT_TOKEN", "REPLACE_WITH_RANDOM_AGENT_TOKEN");
    expect(() => env.agentToken).toThrow(/placeholder/);
    vi.stubEnv("SESSION_SECRET", "REPLACE_WITH_openssl_rand_hex_32_value");
    expect(() => env.sessionSecret).toThrow(/placeholder/);
  });

  it("tolerates short non-placeholder secrets outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SIGNUP_TOKEN", "t");
    vi.stubEnv("AGENT_TOKEN", "t");
    expect(env.signupToken).toBe("t");
    expect(env.agentToken).toBe("t");
  });

  it("enforces a strength floor only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENT_TOKEN", "short");
    expect(() => env.agentToken).toThrow(/at least 16 characters in production/);
    vi.stubEnv("AGENT_TOKEN", "aaaaaaaaaaaaaaaaaaaa");
    expect(() => env.agentToken).toThrow(/single repeated character/);
    vi.stubEnv("AGENT_TOKEN", "a-strong-enough-agent-token-value");
    expect(env.agentToken).toBe("a-strong-enough-agent-token-value");
  });
});

describe("CONTROLLER_DOMAIN", () => {
  it("returns '' when unset (same-origin)", () => {
    vi.stubEnv("CONTROLLER_DOMAIN", undefined as unknown as string);
    expect(env.controllerDomain).toBe("");
    expect(env.controllerOrigin).toBe("");
  });

  it("accepts exactly one bare hostname and derives the origin", () => {
    vi.stubEnv("CONTROLLER_DOMAIN", "lab.edwardcheng.net");
    expect(env.controllerDomain).toBe("lab.edwardcheng.net");
    expect(env.controllerOrigin).toBe("https://lab.edwardcheng.net");
  });

  it("lower-cases the hostname", () => {
    vi.stubEnv("CONTROLLER_DOMAIN", "Lab.Edwardcheng.NET");
    expect(env.controllerDomain).toBe("lab.edwardcheng.net");
  });

  it("rejects comma lists, schemes, paths, ports, and wildcards", () => {
    for (const [val, re] of [
      ["a.com,b.com", /one hostname/],
      ["https://lab.edwardcheng.net", /scheme or path/],
      ["lab.edwardcheng.net/x", /scheme or path/],
      ["*.edwardcheng.net", /wildcard/],
      ["lab.edwardcheng.net:8443", /port/],
      ["not a host", /not a valid hostname/],
    ] as [string, RegExp][]) {
      vi.stubEnv("CONTROLLER_DOMAIN", val);
      expect(() => env.controllerDomain).toThrow(re);
    }
  });
});

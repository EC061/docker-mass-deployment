import { afterEach, describe, expect, it, vi } from "vitest";

process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Mock next/headers so clientIp() can read forwarded headers without a real request context.
let store: Record<string, string> = {};
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => store[k.toLowerCase()] ?? null }),
}));

import { clientIp } from "../src/lib/ratelimit";

afterEach(() => {
  delete process.env.CONTROLLER_DOMAIN;
  delete process.env.TRUST_PROXY;
  store = {};
});

describe("clientIp proxy trust (Phase 10)", () => {
  it("ignores spoofable forwarded headers when not behind a trusted proxy", async () => {
    store = { "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" };
    expect(await clientIp()).toBe("untrusted-proxy");
  });

  it("takes the LAST X-Forwarded-For hop (appended by our proxy) when trusted", async () => {
    process.env.TRUST_PROXY = "1";
    store = { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" };
    expect(await clientIp()).toBe("3.3.3.3");
  });

  it("trusts the proxy automatically when CONTROLLER_DOMAIN is configured", async () => {
    process.env.CONTROLLER_DOMAIN = "lab.edwardcheng.net";
    store = { "x-real-ip": "5.5.5.5" };
    expect(await clientIp()).toBe("5.5.5.5");
  });
});

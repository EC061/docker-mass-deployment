import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Configure env before importing modules that read it at load time.
const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-reqadmin-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "test-signup";
process.env.AGENT_TOKEN = "test-agent";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Mutable cookie store backing the next/headers mock.
let cookieValue: string | undefined;
const cookieStore = {
  get: (name: string) => (name === "lab_session" && cookieValue ? { value: cookieValue } : undefined),
  set: () => {},
  delete: () => {
    cookieValue = undefined;
  },
};
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

// redirect() throws NEXT_REDIRECT in real Next; emulate that so callers can't proceed.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

describe("requireAdmin gate", () => {
  let auth: typeof import("../src/lib/auth.js");
  let db: typeof import("../src/lib/db.js");
  let adminId: number;

  beforeAll(async () => {
    auth = await import("../src/lib/auth.js");
    db = await import("../src/lib/db.js");
    const admin = await auth.createAdmin("Ed", "ed@uga.edu", "password123456", "test-signup");
    adminId = admin.id;
  });

  beforeEach(() => {
    cookieValue = undefined;
    // reset admin state between cases
    db.db().prepare("UPDATE admins SET is_active = 1, token_version = 0 WHERE id = ?").run(adminId);
  });

  it("redirects when there is no session cookie", async () => {
    await expect(auth.requireAdmin()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("redirects on a token signed with the wrong secret", async () => {
    cookieValue = "not-a-real-jwt";
    await expect(auth.requireAdmin()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("returns the verified admin for a valid session", async () => {
    cookieValue = await auth.issueSession({ id: adminId, name: "Ed", email: "ed@uga.edu" });
    const admin = await auth.requireAdmin();
    expect(admin.email).toBe("ed@uga.edu");
    expect(admin.id).toBe(adminId);
  });

  it("rejects a disabled admin (is_active = 0)", async () => {
    cookieValue = await auth.issueSession({ id: adminId, name: "Ed", email: "ed@uga.edu" });
    db.db().prepare("UPDATE admins SET is_active = 0 WHERE id = ?").run(adminId);
    await expect(auth.requireAdmin()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("rejects a stale token_version (revoked session)", async () => {
    cookieValue = await auth.issueSession({ id: adminId, name: "Ed", email: "ed@uga.edu" });
    // Bump the version after the token was issued — emulates logout-all / revoke.
    db.db().prepare("UPDATE admins SET token_version = token_version + 1 WHERE id = ?").run(adminId);
    await expect(auth.requireAdmin()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("rejects a deleted admin", async () => {
    cookieValue = await auth.issueSession({ id: 99999, name: "Ghost", email: "ghost@uga.edu" });
    await expect(auth.requireAdmin()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });
});

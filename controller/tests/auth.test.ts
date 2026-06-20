import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Configure env before importing modules that read it at load time.
const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "test-signup";
process.env.AGENT_TOKEN = "test-agent";
process.env.SESSION_SECRET = "test-session-secret-test-session";

describe("admin signup token gate", () => {
  let auth: typeof import("../src/lib/auth.js");

  beforeAll(async () => {
    auth = await import("../src/lib/auth.js");
  });

  it("rejects a wrong signup token", async () => {
    await expect(
      auth.createAdmin("Ed", "ed@uga.edu", "password123", "wrong-token"),
    ).rejects.toThrow(/signup token/i);
    expect(auth.adminCount()).toBe(0);
  });

  it("creates an admin with the correct token and verifies login", async () => {
    const admin = await auth.createAdmin("Ed", "ed@uga.edu", "password123", "test-signup");
    expect(admin.email).toBe("ed@uga.edu");
    expect(auth.adminCount()).toBe(1);

    const ok = await auth.verifyLogin("ed@uga.edu", "password123");
    expect(ok?.email).toBe("ed@uga.edu");

    const bad = await auth.verifyLogin("ed@uga.edu", "wrongpass");
    expect(bad).toBeNull();
  });

  it("rejects duplicate email", async () => {
    await expect(
      auth.createAdmin("Ed2", "ed@uga.edu", "password123", "test-signup"),
    ).rejects.toThrow(/already exists/i);
  });
});

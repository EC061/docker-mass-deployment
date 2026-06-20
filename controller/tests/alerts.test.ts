import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-p5-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Count sendMail invocations instead of really sending.
const sendMail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendMail }));

let alerts: typeof import("../src/lib/alerts");
let dbmod: typeof import("../src/lib/db");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  alerts = await import("../src/lib/alerts");
  dbmod
    .db()
    .prepare("INSERT INTO admins (name, email, password_hash, created_at) VALUES ('A','a@uga.edu','x',0)")
    .run();
});

describe("admin alerts", () => {
  it("ignores logs below the threshold (default ERROR)", () => {
    sendMail.mockClear();
    alerts.maybeAlertOnLog({ node: "n", level: "INFO", source: "s", msg: "hi" });
    alerts.maybeAlertOnLog({ node: "n", level: "WARN", source: "s", msg: "warn" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("alerts on ERROR and dedupes repeats within the window", async () => {
    sendMail.mockClear();
    alerts.maybeAlertOnLog({ node: "n", level: "ERROR", source: "zfs", msg: "boom" });
    alerts.maybeAlertOnLog({ node: "n", level: "ERROR", source: "zfs", msg: "boom again" });
    // Let the async alertAdmins microtasks resolve.
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMail).toHaveBeenCalledTimes(1); // second suppressed by dedup
  });

  it("different keys each alert", async () => {
    sendMail.mockClear();
    await alerts.alertAdmins("k1", "s1", "b1");
    await alerts.alertAdmins("k2", "s2", "b2");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});

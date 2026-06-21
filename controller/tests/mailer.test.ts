import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-mailer-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Capture the messages handed to nodemailer instead of opening an SMTP socket.
const sent: any[] = [];
let failNext = false;
const sendMailImpl = vi.fn(async (msg: any) => {
  if (failNext) throw new Error("smtp down");
  sent.push(msg);
  return { messageId: "1" };
});
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailImpl }) },
}));

let dbmod: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");
let mailer: typeof import("../src/lib/mailer");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
  mailer = await import("../src/lib/mailer");
  void dbmod;
});

beforeEach(() => {
  sent.length = 0;
  failNext = false;
  sendMailImpl.mockClear();
});

function configureSmtp() {
  settings.setSetting("smtpHost", "smtp.uga.edu");
  settings.setSetting("smtpFrom", "labs@uga.edu");
}

describe("sendMail gating", () => {
  it("skips when SMTP is not configured", async () => {
    settings.setSetting("smtpHost", "");
    settings.setSetting("smtpFrom", "");
    const res = await mailer.sendMail("a@uga.edu", "s", "b");
    expect(res).toEqual({ sent: false, skipped: true });
    expect(sendMailImpl).not.toHaveBeenCalled();
  });

  it("skips when there is no recipient", async () => {
    configureSmtp();
    const res = await mailer.sendMail("", "s", "b");
    expect(res.skipped).toBe(true);
  });

  it("sends when configured, using the From setting", async () => {
    configureSmtp();
    const res = await mailer.sendMail("a@uga.edu", "Subject", "Body");
    expect(res).toEqual({ sent: true });
    expect(sent[0]).toMatchObject({ from: "labs@uga.edu", to: "a@uga.edu", subject: "Subject", text: "Body" });
  });

  it("returns the error message when the transport throws", async () => {
    configureSmtp();
    failNext = true;
    const res = await mailer.sendMail("a@uga.edu", "s", "b");
    expect(res.sent).toBe(false);
    expect(res.error).toBe("smtp down");
  });
});

describe("templated emails", () => {
  beforeEach(configureSmtp);

  it("credential email contains the ssh command, username and password", async () => {
    const res = await mailer.sendCredentialEmail({
      to: "a@uga.edu", name: "Alice", username: "alice", password: "pw123",
      host: "gpu-1", port: 2222, lab: "bio",
    });
    expect(res.sent).toBe(true);
    expect(sent[0].subject).toBe("Your access to lab bio");
    expect(sent[0].text).toContain("ssh alice@gpu-1 -p 2222");
    expect(sent[0].text).toContain("Password: pw123");
  });

  it("quota email lists the per-student breakdown", async () => {
    await mailer.sendQuotaEmail({
      to: "pi@uga.edu", lab: "bio", pool: "fast", pct: 92,
      usedHuman: "1.8 TB", quotaHuman: "2.0 TB",
      breakdown: [{ username: "alice", usedHuman: "1.0 TB" }],
    });
    expect(sent[0].subject).toBe("Lab bio is at 92% of its fast quota");
    expect(sent[0].text).toContain("alice");
    expect(sent[0].text).toContain("1.0 TB");
  });

  it("quota email handles an empty breakdown", async () => {
    await mailer.sendQuotaEmail({
      to: "pi@uga.edu", lab: "bio", pool: "slow", pct: 95,
      usedHuman: "x", quotaHuman: "y", breakdown: [],
    });
    expect(sent[0].text).toContain("(no per-student usage reported yet)");
  });

  it("gpu warning and kill emails mention the pid", async () => {
    await mailer.sendGpuWarningEmail("a@uga.edu", { lab: "bio", pid: 42, graceMinutes: 10 });
    expect(sent[0].text).toContain("PID 42");
    expect(sent[0].text).toContain("10 minutes");
    await mailer.sendGpuKillEmail("a@uga.edu", { lab: null, pid: 7 });
    expect(sent[1].text).toContain("PID 7");
  });

  it("removal email distinguishes deleted vs retained data", async () => {
    await mailer.sendRemovalEmail("a@uga.edu", "bio", true);
    expect(sent[0].text).toContain("has been deleted");
    await mailer.sendRemovalEmail("a@uga.edu", "bio", false);
    expect(sent[1].text).toContain("retained");
  });
});

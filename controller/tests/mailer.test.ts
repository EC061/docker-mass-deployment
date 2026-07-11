import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { legacySignatureHtmlToText } from "../src/lib/template";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-mailer-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Capture the messages handed to nodemailer instead of opening an SMTP socket.
const sent: any[] = [];
let failNext = false;
const failedHosts = new Set<string>();
const sendMailImpl = vi.fn(async (msg: any) => {
  if (failNext) throw new Error("smtp down");
  sent.push(msg);
  return { messageId: "1" };
});
const transports: any[] = [];
vi.mock("nodemailer", () => ({
  default: { createTransport: (options: any) => {
    transports.push(options);
    return {
      sendMail: async (msg: any) => {
        if (failedHosts.has(options.host)) throw new Error(`${options.host} down`);
        return sendMailImpl(msg);
      },
    };
  } },
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
  transports.length = 0;
  failedHosts.clear();
  failNext = false;
  sendMailImpl.mockClear();
});

function configureSmtp() {
  settings.setSetting("smtpConfigs", [{
    id: "primary", name: "Primary", rank: 1, host: "smtp.uga.edu", port: 587,
    user: "", pass: "", from: "labs@uga.edu", secure: false,
  }]);
}

describe("sendMail gating", () => {
  it("skips when SMTP is not configured", async () => {
    settings.setSetting("smtpConfigs", []);
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
    expect(sent[0]).toMatchObject({ from: "labs@uga.edu", to: "a@uga.edu", subject: "Subject" });
    expect(sent[0].text).toContain("Body\n\nNingxi Cheng, Graduate Research Assistant");
    expect(sent[0]).not.toHaveProperty("html");
  });

  it("returns the error message when the transport throws", async () => {
    configureSmtp();
    failNext = true;
    const res = await mailer.sendMail("a@uga.edu", "s", "b");
    expect(res.sent).toBe(false);
    expect(res.error).toBe("smtp down");
  });

  it("fails over through SMTP configs in rank order", async () => {
    settings.setSetting("smtpConfigs", [
      { id: "backup", name: "Backup", rank: 20, host: "smtp.backup", port: 465, user: "b", pass: "bp", from: "backup@example.com", secure: true },
      { id: "primary", name: "Primary", rank: 10, host: "smtp.primary", port: 587, user: "p", pass: "pp", from: "primary@example.com", secure: false },
    ]);
    failedHosts.add("smtp.primary");

    const res = await mailer.sendMail("a@uga.edu", "Subject", "Body");

    expect(res).toEqual({ sent: true });
    expect(transports.map((options) => options.host)).toEqual(["smtp.primary", "smtp.backup"]);
    expect(sent[0].from).toBe("backup@example.com");
  });

  it("returns every ranked failure when all SMTP configs fail", async () => {
    settings.setSetting("smtpConfigs", [
      { id: "one", name: "First", rank: 1, host: "smtp.one", port: 587, user: "", pass: "", from: "one@example.com", secure: false },
      { id: "two", name: "Second", rank: 2, host: "smtp.two", port: 587, user: "", pass: "", from: "two@example.com", secure: false },
    ]);
    failedHosts.add("smtp.one");
    failedHosts.add("smtp.two");

    const res = await mailer.sendMail("a@uga.edu", "Subject", "Body");

    expect(res).toEqual({ sent: false, error: "First: smtp.one down; Second: smtp.two down" });
  });
});

describe("legacy signature migration", () => {
  it("converts saved HTML into readable plain text", () => {
    const html =
      '<div><strong>Research &amp; Compute</strong><br><a href="mailto:team@uga.edu">team@uga.edu</a><img src="logo.png" alt="UGA"></div>';
    expect(legacySignatureHtmlToText(html)).toBe("Research & Compute\nteam@uga.edu\nUGA");
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

  it("renderTemplate substitutes known tokens and leaves unknown ones intact", () => {
    const out = mailer.renderTemplate("hi {name} on {node}, missing {nope}", { name: "Al", node: "n1" });
    expect(out).toBe("hi Al on n1, missing {nope}");
  });

  it("credential email honors a custom subject/body template with the node variable", async () => {
    settings.setSetting("welcomeEmailSubject", "Welcome {name} to {lab}");
    settings.setSetting("welcomeEmailBody", "User {username} pw {password} on node {node} ({host})");
    await mailer.sendCredentialEmail({
      to: "a@uga.edu", name: "Alice", username: "alice", password: "pw123",
      host: "gpu-1.uga.edu", port: 2222, lab: "bio", node: "gpu-1",
    });
    expect(sent[0].subject).toBe("Welcome Alice to bio");
    expect(sent[0].text).toContain("User alice pw pw123 on node gpu-1 (gpu-1.uga.edu)");
    // Restore defaults so later tests see the built-in template.
    settings.setSetting("welcomeEmailSubject", "");
    settings.setSetting("welcomeEmailBody", "");
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

  it("renders placement completion and per-user quota templates", async () => {
    await mailer.sendPlacementCompleteEmail({
      to: "pi@uga.edu", name: "Dr. Smith", lab: "bio", node: "GPU One",
      usernames: ["alice", "prof"], fastQuota: "2 TiB", coldQuota: "3 TiB",
      studentFastQuota: "500 GiB", studentColdQuota: "shared placement quota",
    });
    expect(sent[0].subject).toContain("Node setup complete");
    expect(sent[0].text).toContain("alice\n  prof");
    expect(sent[0].text).toContain("Per-user fast: 500 GiB");

    await mailer.sendStudentQuotaEmail({
      to: "alice@uga.edu", name: "Alice", username: "alice", lab: "bio", node: "gpu-1",
      pool: "fast", pct: 51, usedHuman: "255 GiB", quotaHuman: "500 GiB",
    });
    expect(sent[1].subject).toContain("51% full");
    expect(sent[1].text).toContain("255 GiB of its 500 GiB");
  });

  it("gpu warning and kill emails mention the pid", async () => {
    await mailer.sendGpuWarningEmail("a@uga.edu", { username: "alice", lab: "bio", pid: 42, node: "gpu-01", graceMinutes: 10 });
    expect(sent[0].text).toContain("PID 42");
    expect(sent[0].text).toContain("10 minutes");
    await mailer.sendGpuKillEmail("a@uga.edu", { username: "bob", lab: null, pid: 7, node: "gpu-01" });
    expect(sent[1].text).toContain("PID 7");
  });

  it("gpu emails render the admin-editable template", async () => {
    configureSmtp();
    settings.setSetting("gpuWarnEmailSubject", "Heads up {username}");
    settings.setSetting("gpuWarnEmailBody", "PID {pid} on {node} — {grace_minutes}m left");
    await mailer.sendGpuWarningEmail("a@uga.edu", { username: "alice", lab: "bio", pid: 42, node: "gpu-01", graceMinutes: 15 });
    expect(sent[0].subject).toBe("Heads up alice");
    expect(sent[0].text).toContain("PID 42 on gpu-01 — 15m left");
  });

  it("removal email distinguishes deleted vs retained data", async () => {
    await mailer.sendRemovalEmail("a@uga.edu", "bio", true);
    expect(sent[0].text).toContain("has been deleted");
    await mailer.sendRemovalEmail("a@uga.edu", "bio", false);
    expect(sent[1].text).toContain("retained");
  });

  it("removal, quota, and test emails honor admin-editable templates", async () => {
    settings.setSetting("removalEmailSubject", "Bye from {lab}");
    settings.setSetting("removalEmailBody", "Lab {lab}: {data_status}");
    await mailer.sendRemovalEmail("a@uga.edu", "bio", true);
    expect(sent[0].subject).toBe("Bye from bio");
    expect(sent[0].text).toContain("Lab bio: Your home and cold-storage data in this lab has been deleted.");

    settings.setSetting("quotaEmailSubject", "{lab} {pct}% full");
    settings.setSetting("quotaEmailBody", "{used}/{quota} on {pool}\n{breakdown}");
    await mailer.sendQuotaEmail({
      to: "pi@uga.edu", lab: "bio", pool: "fast", pct: 91,
      usedHuman: "1.8 TB", quotaHuman: "2.0 TB", breakdown: [{ username: "alice", usedHuman: "1.0 TB" }],
    });
    expect(sent[1].subject).toBe("bio 91% full");
    expect(sent[1].text).toContain("1.8 TB/2.0 TB on fast");
    expect(sent[1].text).toContain("alice");

    settings.setSetting("testEmailSubject", "ping");
    settings.setSetting("testEmailBody", "pong");
    await mailer.sendTestEmail("a@uga.edu");
    expect(sent[2].subject).toBe("ping");
    expect(sent[2].text).toContain("pong\n\nNingxi Cheng");

    // Restore defaults so later tests / runs see the built-in templates.
    for (const k of ["removalEmailSubject", "removalEmailBody", "quotaEmailSubject", "quotaEmailBody", "testEmailSubject", "testEmailBody"] as const) {
      settings.setSetting(k, "");
    }
  });

  it("preserves body formatting and appends the editable plain-text signature", async () => {
    settings.setSetting("emailSignatureText", "Research Team\nteam@uga.edu");

    await mailer.sendMail("a@uga.edu", "Signed", "Message body\nsecond line\n\n— Lab Manager");

    expect(sent[0].text).toBe("Message body\nsecond line\n\nResearch Team\nteam@uga.edu");
    expect(sent[0]).not.toHaveProperty("html");
    settings.setSetting("emailSignatureText", settings.DEFAULT_EMAIL_SIGNATURE_TEXT);
  });
});

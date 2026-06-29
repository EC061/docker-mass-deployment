import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-ann-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const sendMail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendMail }));

let ann: typeof import("../src/lib/announcements");
let dbmod: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
  ann = await import("../src/lib/announcements");
  const d = dbmod.db();
  // Two students with email, one without; one duplicate email shared with a PI.
  d.prepare("INSERT INTO students (username, email, created_at) VALUES ('alice','alice@uga.edu',0)").run();
  d.prepare("INSERT INTO students (username, email, created_at) VALUES ('bob','shared@uga.edu',0)").run();
  d.prepare("INSERT INTO students (username, email, created_at) VALUES ('carol',NULL,0)").run();
  // Two labs, distinct PIs (one PI email duplicated across labs, one shared with student bob).
  const lab = (name: string, pi: string | null) =>
    d.prepare("INSERT INTO labs (name, pi_email, created_at, updated_at) VALUES (?,?,0,0)").run(name, pi);
  lab("labA", "pi1@uga.edu");
  lab("labB", "pi1@uga.edu"); // duplicate PI
  lab("labC", "shared@uga.edu"); // also a student email
});

describe("announcement audiences", () => {
  it("counts distinct addressable recipients per audience", () => {
    const c = ann.audienceCounts();
    expect(c.students).toBe(2); // alice + bob (carol has no email)
    expect(c.pis).toBe(2); // pi1 + shared (deduped across labs)
  });
});

describe("sendAnnouncement", () => {
  it("rejects empty subject/body/audience", async () => {
    await expect(ann.sendAnnouncement({ subject: "", body: "x", audiences: ["students"] })).rejects.toThrow();
    await expect(ann.sendAnnouncement({ subject: "s", body: "", audiences: ["students"] })).rejects.toThrow();
    await expect(ann.sendAnnouncement({ subject: "s", body: "b", audiences: [] })).rejects.toThrow();
  });

  it("dedupes across audiences and records a row", async () => {
    // Configure SMTP so the send is not skipped.
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    const res = await ann.sendAnnouncement({
      subject: "Maintenance",
      body: "Down Saturday",
      audiences: ["students", "pis"],
      actor: "admin@uga.edu",
    });

    // Union of {alice, shared, pi1, shared} = alice, shared, pi1 → 3 distinct.
    expect(res.recipients).toBe(3);
    expect(res.sent).toBe(3);
    expect(res.skipped).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(3);

    const row = dbmod
      .db()
      .prepare("SELECT * FROM announcements ORDER BY id DESC LIMIT 1")
      .get() as { audiences: string; recipients: number; sent: number; skipped: number };
    expect(row.audiences).toBe("students,pis");
    expect(row.recipients).toBe(3);
    expect(row.skipped).toBe(0);
  });

  it("substitutes {name}/{email} per recipient and appends the signature", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    await ann.sendAnnouncement({
      subject: "Hi {name}",
      body: "Your address is {email}.",
      audiences: ["students"],
    });

    const calls = sendMail.mock.calls as unknown as [string, string, string][];
    const aliceCall = calls.find((c) => c[0] === "alice@uga.edu");
    expect(aliceCall).toBeTruthy();
    expect(aliceCall![1]).toBe("Hi alice"); // no name set → falls back to username
    expect(aliceCall![2]).toBe("Your address is alice@uga.edu.\n\n— Lab Manager");
  });

  it("skips sending when SMTP is not configured but still records", async () => {
    settings.setSetting("smtpHost", "");
    settings.setSetting("smtpFrom", "");
    sendMail.mockClear();

    const res = await ann.sendAnnouncement({ subject: "Hi", body: "there", audiences: ["students"] });
    expect(res.skipped).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
    expect(res.recipients).toBe(2);

    const row = dbmod.db().prepare("SELECT skipped FROM announcements ORDER BY id DESC LIMIT 1").get() as {
      skipped: number;
    };
    expect(row.skipped).toBe(1);
  });
});

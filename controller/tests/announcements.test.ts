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
let tpl: typeof import("../src/lib/template");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
  ann = await import("../src/lib/announcements");
  tpl = await import("../src/lib/template");
  const d = dbmod.db();
  // Two students with email, one without; one duplicate email shared with a PI.
  d.prepare("INSERT INTO students (username, email, linux_uid, created_at) VALUES ('alice','alice@uga.edu',10000,0)").run();
  d.prepare("INSERT INTO students (username, email, linux_uid, created_at) VALUES ('bob','shared@uga.edu',10001,0)").run();
  d.prepare("INSERT INTO students (username, email, linux_uid, created_at) VALUES ('carol',NULL,10002,0)").run();
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

  it("substitutes {name}/{email} before passing the body to the universal-signature mailer", async () => {
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
    expect(aliceCall![2]).toBe("Your address is alice@uga.edu.");
  });

  it("substitutes {sender}/{sender_email} when a sender is given, leaves them visible otherwise", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    await ann.sendAnnouncement({
      subject: "A note from {sender}",
      body: "Reply to {sender_email} with questions, {name}.",
      audiences: ["students"],
      sender: { name: "Dr. Admin", email: "admin@uga.edu" },
    });
    let aliceCall = (sendMail.mock.calls as unknown as [string, string, string][]).find(
      (c) => c[0] === "alice@uga.edu",
    )!;
    expect(aliceCall[1]).toBe("A note from Dr. Admin");
    expect(aliceCall[2]).toBe("Reply to admin@uga.edu with questions, alice.");

    // Without a sender the tokens stay visible, mirroring how unknown tokens surface typos.
    sendMail.mockClear();
    await ann.sendAnnouncement({ subject: "From {sender}", body: "b", audiences: ["students"] });
    aliceCall = (sendMail.mock.calls as unknown as [string, string, string][]).find(
      (c) => c[0] === "alice@uga.edu",
    )!;
    expect(aliceCall[1]).toBe("From {sender}");
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

describe("bracket placeholder helpers", () => {
  it("extracts tokens deduped, in first-appearance order, including multi-word tokens", () => {
    expect(tpl.extractBracketTokens("on [DATE] from [START TIME] to [END], again [DATE]")).toEqual([
      "DATE",
      "START TIME",
      "END",
    ]);
  });

  it("ignores {vars}, lowercase brackets, and spans not starting with a capital", () => {
    expect(tpl.extractBracketTokens("Hi {name}, see [notes] and [1TH]")).toEqual([]);
  });

  it("fills every occurrence and leaves unknown tokens intact", () => {
    expect(tpl.fillBracketTokens("[DATE] and [DATE] but [OTHER]", { DATE: "Saturday" })).toBe(
      "Saturday and Saturday but [OTHER]",
    );
  });

  it("never re-substitutes a value that itself contains a bracket span", () => {
    expect(tpl.fillBracketTokens("[A] [B]", { A: "[B]", B: "two" })).toBe("[B] two");
  });
});

describe("sendAnnouncement placeholders", () => {
  it("rejects a send while [BRACKET] placeholders are unfilled or blank", async () => {
    await expect(
      ann.sendAnnouncement({ subject: "Downtime [DATE]", body: "from [START]", audiences: ["students"] }),
    ).rejects.toThrow(/\[DATE\], \[START\]/);
    await expect(
      ann.sendAnnouncement({
        subject: "Downtime [DATE]",
        body: "x",
        audiences: ["students"],
        placeholders: { DATE: "  " },
      }),
    ).rejects.toThrow(/\[DATE\]/);
  });

  it("mails and records the filled text", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    await ann.sendAnnouncement({
      subject: "Downtime [DATE]",
      body: "Cluster down [DATE] [START]–[END].",
      audiences: ["students"],
      placeholders: { DATE: "Saturday", START: "8am", END: "noon" },
    });

    const calls = sendMail.mock.calls as unknown as [string, string, string][];
    expect(calls[0][1]).toBe("Downtime Saturday");
    expect(calls[0][2]).toBe("Cluster down Saturday 8am–noon.");

    const row = dbmod
      .db()
      .prepare("SELECT subject, body FROM announcements ORDER BY id DESC LIMIT 1")
      .get() as { subject: string; body: string };
    expect(row.subject).toBe("Downtime Saturday");
    expect(row.body).toBe("Cluster down Saturday 8am–noon.");
  });

  it("fills placeholders before per-recipient {name} rendering", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    await ann.sendAnnouncement({
      subject: "s",
      body: "Contact: [CONTACT] for {name}",
      audiences: ["students"],
      placeholders: { CONTACT: "{email}" },
    });

    const aliceCall = (sendMail.mock.calls as unknown as [string, string, string][]).find(
      (c) => c[0] === "alice@uga.edu",
    )!;
    // The filled value is itself template-rendered per recipient — current (accepted) behavior.
    expect(aliceCall[2]).toBe("Contact: alice@uga.edu for alice");
  });
});

describe("individual recipients", () => {
  it("lists students and PIs deduped by email, students winning", () => {
    const people = ann.listAnnouncementPeople();
    expect(people.map((p) => p.email).sort()).toEqual(["alice@uga.edu", "pi1@uga.edu", "shared@uga.edu"]);
    expect(people.find((p) => p.email === "shared@uga.edu")).toMatchObject({ kind: "user", name: "bob" });
    expect(people.find((p) => p.email === "pi1@uga.edu")).toMatchObject({ kind: "pi" });
  });

  it("sends to picked individuals with no audience selected", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    const res = await ann.sendAnnouncement({
      subject: "s",
      body: "b",
      audiences: [],
      individuals: ["alice@uga.edu", "alice@uga.edu"],
    });
    expect(res.recipients).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);

    const row = dbmod
      .db()
      .prepare("SELECT audiences FROM announcements ORDER BY id DESC LIMIT 1")
      .get() as { audiences: string };
    expect(row.audiences).toBe("1 picked");
  });

  it("dedupes a picked individual already covered by an audience and labels the history row", async () => {
    settings.setSetting("smtpHost", "smtp.test");
    settings.setSetting("smtpFrom", "no-reply@uga.edu");
    sendMail.mockClear();

    const res = await ann.sendAnnouncement({
      subject: "s",
      body: "b",
      audiences: ["students"],
      individuals: ["shared@uga.edu"],
    });
    expect(res.recipients).toBe(2); // alice + shared, not 3

    const row = dbmod
      .db()
      .prepare("SELECT audiences FROM announcements ORDER BY id DESC LIMIT 1")
      .get() as { audiences: string };
    expect(row.audiences).toBe("students,1 picked");
  });

  it("rejects unknown recipient emails and an empty selection", async () => {
    await expect(
      ann.sendAnnouncement({ subject: "s", body: "b", audiences: [], individuals: ["evil@example.com"] }),
    ).rejects.toThrow(/unknown recipient/);
    await expect(
      ann.sendAnnouncement({ subject: "s", body: "b", audiences: [], individuals: [] }),
    ).rejects.toThrow(/audience or recipient/);
  });
});

describe("announcement history deletion", () => {
  it("deletes a single announcement and records an audit entry", async () => {
    await ann.sendAnnouncement({ subject: "to delete", body: "b", audiences: ["students"] });
    const d = dbmod.db();
    const row = d.prepare("SELECT id FROM announcements ORDER BY id DESC LIMIT 1").get() as { id: number };
    const before = (d.prepare("SELECT COUNT(*) AS n FROM announcements").get() as { n: number }).n;

    ann.deleteAnnouncement(row.id, "admin@uga.edu");

    expect((d.prepare("SELECT COUNT(*) AS n FROM announcements").get() as { n: number }).n).toBe(before - 1);
    expect(d.prepare("SELECT id FROM announcements WHERE id = ?").get(row.id)).toBeUndefined();
    expect(
      d.prepare("SELECT actor, action FROM audit_log ORDER BY id DESC LIMIT 1").get(),
    ).toMatchObject({ actor: "admin@uga.edu", action: "announcement.delete" });
  });

  it("throws when the announcement does not exist", () => {
    expect(() => ann.deleteAnnouncement(999999, "admin@uga.edu")).toThrow(/not found/);
  });

  it("clears the whole history, returns the count, and records an audit entry", () => {
    const d = dbmod.db();
    const before = (d.prepare("SELECT COUNT(*) AS n FROM announcements").get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);

    expect(ann.clearAnnouncements("admin@uga.edu")).toBe(before);

    expect((d.prepare("SELECT COUNT(*) AS n FROM announcements").get() as { n: number }).n).toBe(0);
    expect(
      d.prepare("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get(),
    ).toMatchObject({
      actor: "admin@uga.edu",
      action: "announcements.clear",
      detail: `${before} announcement(s)`,
    });
  });
});

describe("announcement templates", () => {
  it("seeds the built-in defaults without the dropped templates", () => {
    const names = ann.listAnnouncementTemplates().map((t) => t.name);
    expect(names).toContain("Scheduled maintenance");
    expect(names).toContain("Storage cleanup request");
    expect(names).toContain("System introduction");
    expect(names).not.toContain("Access expiring");
    expect(names).not.toContain("New capacity available");
  });

  it("creates, updates, and deletes a template", () => {
    const before = ann.listAnnouncementTemplates().length;
    const id = ann.createAnnouncementTemplate({ name: "Holiday", subject: "Closed", body: "Hello {name}" });
    const created = ann.listAnnouncementTemplates().find((t) => t.id === id)!;
    expect(created).toMatchObject({ name: "Holiday", subject: "Closed", body: "Hello {name}" });
    // Appended to the end of the display order.
    expect(ann.listAnnouncementTemplates().at(-1)!.id).toBe(id);

    ann.updateAnnouncementTemplate(id, { name: "Holiday closure", subject: "We're closed", body: "Bye {name}" });
    const updated = ann.listAnnouncementTemplates().find((t) => t.id === id)!;
    expect(updated).toMatchObject({ name: "Holiday closure", subject: "We're closed", body: "Bye {name}" });

    ann.deleteAnnouncementTemplate(id);
    expect(ann.listAnnouncementTemplates()).toHaveLength(before);
    expect(ann.listAnnouncementTemplates().find((t) => t.id === id)).toBeUndefined();
  });

  it("rejects a blank name or body, and updating a missing row", () => {
    expect(() => ann.createAnnouncementTemplate({ name: "  ", subject: "s", body: "b" })).toThrow(/name/);
    expect(() => ann.createAnnouncementTemplate({ name: "n", subject: "s", body: "  " })).toThrow(/body/);
    expect(() => ann.updateAnnouncementTemplate(99999, { name: "n", subject: "s", body: "b" })).toThrow(/not found/);
  });
});

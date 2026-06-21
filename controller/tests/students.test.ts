import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-students-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const enqueueTask = vi.fn(() => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));

const sendCredentialEmail = vi.fn(async (..._args: unknown[]) => ({ sent: true }));
const sendRemovalEmail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendCredentialEmail, sendRemovalEmail }));

let dbmod: typeof import("../src/lib/db");
let students: typeof import("../src/lib/students");
let labs: typeof import("../src/lib/labs");
let labId: number;

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  students = await import("../src/lib/students");
  labs = await import("../src/lib/labs");
  dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, 0)").run();
  const nodeId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
  const lab = labs.createLab({
    name: "bio",
    nodeId,
    fastQuotaBytes: 1000,
    slowQuotaBytes: 2000,
    image: "custom-ssh",
    sshPort: 2222,
  });
  labId = lab.id;
});

beforeEach(() => {
  enqueueTask.mockClear();
  sendCredentialEmail.mockClear();
  sendRemovalEmail.mockClear();
});

describe("generatePassword", () => {
  it("produces the requested length from the safe alphabet", () => {
    const pw = students.generatePassword(16);
    expect(pw).toHaveLength(16);
    expect(pw).toMatch(/^[a-zA-Z0-9]+$/);
    // Avoids visually ambiguous characters (l, o, I, O, 0, 1).
    expect(pw).not.toMatch(/[loIO01]/);
  });

  it("defaults to length 12 and is non-deterministic", () => {
    expect(students.generatePassword()).toHaveLength(12);
    expect(students.generatePassword()).not.toBe(students.generatePassword());
  });
});

describe("findOrCreateStudent", () => {
  it("creates a student then returns the same row on repeat", () => {
    const a = students.findOrCreateStudent({ username: "newbie", email: "n@uga.edu" });
    const b = students.findOrCreateStudent({ username: "newbie" });
    expect(a.id).toBe(b.id);
    expect(b.email).toBe("n@uga.edu");
  });
});

describe("addStudentToLab", () => {
  it("creates membership, enqueues student.add, and emails credentials", async () => {
    const res = await students.addStudentToLab(labId, { username: "alice", email: "a@uga.edu" }, "admin");
    expect(res.student.username).toBe("alice");
    expect(res.password).toHaveLength(12);
    expect(res.emailed).toBe(true);

    const member = dbmod
      .db()
      .prepare(
        "SELECT * FROM lab_members WHERE lab_id=? AND student_id=(SELECT id FROM students WHERE username='alice')",
      )
      .get(labId);
    expect(member).toBeTruthy();

    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "student.add",
      expect.objectContaining({ lab: "bio", username: "alice", password: res.password }),
      "admin",
    );
    const cred = sendCredentialEmail.mock.calls[0][0] as any;
    expect(cred).toMatchObject({ to: "a@uga.edu", username: "alice", port: 2222, lab: "bio" });
  });

  it("does not email when the student has no address", async () => {
    const res = await students.addStudentToLab(labId, { username: "bob" });
    expect(res.emailed).toBe(false);
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

  it("rejects a duplicate membership", async () => {
    await students.addStudentToLab(labId, { username: "carol", email: "c@uga.edu" });
    await expect(students.addStudentToLab(labId, { username: "carol" })).rejects.toThrow(
      /already a member/,
    );
  });

  it("throws for an unknown lab", async () => {
    await expect(students.addStudentToLab(999999, { username: "x" })).rejects.toThrow(/Unknown lab/);
  });
});

describe("listMembers / removeStudentFromLab", () => {
  it("lists members and removes one, enqueuing student.remove + removal email", async () => {
    await students.addStudentToLab(labId, { username: "dave", email: "d@uga.edu" });
    const before = students.listMembers(labId);
    const dave = before.find((m) => m.username === "dave")!;
    expect(dave).toBeTruthy();

    enqueueTask.mockClear();
    students.removeStudentFromLab(labId, dave.id, true, "admin");

    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "student.remove",
      { lab: "bio", username: "dave", delete_data: true },
      "admin",
    );
    expect(sendRemovalEmail).toHaveBeenCalledWith("d@uga.edu", "bio", true);
    expect(students.listMembers(labId).find((m) => m.username === "dave")).toBeUndefined();
  });
});

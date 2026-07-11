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
const sendPlacementCompleteEmail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendCredentialEmail, sendRemovalEmail, sendPlacementCompleteEmail }));

let dbmod: typeof import("../src/lib/db");
let students: typeof import("../src/lib/students");
let labs: typeof import("../src/lib/labs");
let placements: typeof import("../src/lib/placements");
let labId: number; // a lab with one placement on gpu-1
let rosterOnlyLabId: number; // a lab with no placement

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  students = await import("../src/lib/students");
  labs = await import("../src/lib/labs");
  placements = await import("../src/lib/placements");
  dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('gpu-1', 1, 0)").run();
  const nodeId = (dbmod.db().prepare("SELECT id FROM nodes WHERE name='gpu-1'").get() as any).id;
  const lab = labs.createLab({ name: "bio", actor: "admin" });
  labId = lab.id;
  await placements.createPlacement({
    labId,
    nodeId,
    fastQuotaBytes: 1000,
    coldQuotaBytes: 2000,
    sshPort: 2222,
    image: "custom-ssh",
    containerOptions: { cpus: "4", memory: "8g", shm_size: "1g", rootfs_quota: "300g", restart: "unless-stopped" },
  });
  rosterOnlyLabId = labs.createLab({ name: "noplacement", actor: "admin" }).id;
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
    expect(pw).not.toMatch(/[loIO01]/);
  });

  it("is non-deterministic", () => {
    expect(students.generatePassword()).not.toBe(students.generatePassword());
  });
});

describe("findOrCreateStudent", () => {
  it("creates a student then returns the same row on repeat (by username)", () => {
    const a = students.findOrCreateStudent({ username: "newbie", email: "n@uga.edu" });
    const b = students.findOrCreateStudent({ username: "newbie" });
    expect(a.id).toBe(b.id);
    expect(b.email).toBe("n@uga.edu");
    expect(a.linux_uid).toBeGreaterThanOrEqual(10_000);
    expect(a.linux_uid).toBeLessThanOrEqual(59_999);
  });

  it("matches by student_id before username", () => {
    const a = students.findOrCreateStudent({ username: "sid1", studentId: "100" });
    // Same student_id, different username -> still resolves to the same record.
    const b = students.findOrCreateStudent({ username: "sid1-renamed", studentId: "100" });
    expect(b.id).toBe(a.id);
  });
});

describe("addStudentToLab (provisions on every placement)", () => {
  it("provisions the PI through the student flow and protects the account from removal", async () => {
    const res = await students.ensurePiAccess(
      rosterOnlyLabId,
      { username: "prof", email: "prof@uga.edu", name: "Dr. Prof" },
      "admin",
    );
    expect(res.provisioned).toHaveLength(0);
    const pi = students.listMembers(rosterOnlyLabId).find((member) => member.username === "prof")!;
    expect(pi.is_pi).toBe(1);
    expect(() => students.removeStudentFromLab(rosterOnlyLabId, pi.id, true, "admin"))
      .toThrow(/PI account is protected/);
  });

  it("queues student.add but withholds credentials until the agent confirms success", async () => {
    const res = await students.addStudentToLab(labId, { username: "alice", email: "a@uga.edu" }, "admin");
    expect(res.student.username).toBe("alice");
    expect(res.provisioned).toHaveLength(1);
    expect(res.provisioned[0].node).toBe("gpu-1");

    expect(dbmod.db().prepare(
      "SELECT 1 FROM lab_members WHERE lab_id=? AND student_id=(SELECT id FROM students WHERE username='alice')",
    ).get(labId)).toBeTruthy();
    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "student.add",
      expect.objectContaining({
        lab: "bio", username: "alice", password: expect.any(String),
        uid: res.student.linux_uid, gid: res.student.linux_uid,
      }),
      "admin",
    );
    expect(sendCredentialEmail).not.toHaveBeenCalled();
    const pending = dbmod.db().prepare(
      `SELECT pm.credential_secret AS secret FROM placement_members pm
       JOIN students ON students.id = pm.student_id WHERE students.username = 'alice'`,
    ).get() as any;
    expect(pending.secret).toMatch(/^enc:v1:/);

    placements.markPlacementMemberState("bio", "gpu-1", "alice", "active");
    expect(await placements.deliverPlacementCredential("bio", "gpu-1", "alice")).toBe(true);
    const cred = sendCredentialEmail.mock.calls[0][0] as any;
    expect(cred).toMatchObject({ to: "a@uga.edu", username: "alice", port: 2222, lab: "bio", node: "gpu-1" });
    expect(dbmod.db().prepare(
      `SELECT pm.credential_secret AS secret FROM placement_members pm
       JOIN students ON students.id = pm.student_id WHERE students.username = 'alice'`,
    ).get()).toMatchObject({ secret: null });
  });

  it("allows a one-time admin reveal after success when no email was delivered", async () => {
    const res = await students.addStudentToLab(labId, { username: "bob" });
    expect(res.provisioned[0].node).toBe("gpu-1");
    expect(sendCredentialEmail).not.toHaveBeenCalled();
    placements.markPlacementMemberState("bio", "gpu-1", "bob", "active");
    expect(await placements.deliverPlacementCredential("bio", "gpu-1", "bob")).toBe(false);
    const bob = students.listMembers(labId).find((member) => member.username === "bob")!;
    const placement = placements.listPlacements(labId)[0];
    const revealed = placements.consumePlacementCredential(placement.id, bob.id, "admin");
    expect(revealed.username).toBe("bob");
    expect(revealed.password.length).toBeGreaterThanOrEqual(12);
    expect(() => placements.consumePlacementCredential(placement.id, bob.id, "admin")).toThrow(/already delivered or revealed/);
  });

  it("adds to the roster only (no provisioning) when the lab has no placement", async () => {
    const res = await students.addStudentToLab(rosterOnlyLabId, { username: "carol", email: "c@uga.edu" });
    expect(res.provisioned).toHaveLength(0);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

  it("rejects a duplicate membership and an unknown lab", async () => {
    await students.addStudentToLab(labId, { username: "dup", email: "d@uga.edu" });
    await expect(students.addStudentToLab(labId, { username: "dup" })).rejects.toThrow(/already a member/);
    await expect(students.addStudentToLab(999999, { username: "x" })).rejects.toThrow(/Unknown lab/);
  });
});

describe("removeStudentFromLab (deprovisions on every placement)", () => {
  it("enqueues student.remove, drops membership, and emails once", async () => {
    await students.addStudentToLab(labId, { username: "dave", email: "d@uga.edu" });
    const dave = students.listMembers(labId).find((m) => m.username === "dave")!;
    enqueueTask.mockClear();

    students.removeStudentFromLab(labId, dave.id, true, "admin");
    expect(enqueueTask).toHaveBeenCalledWith(
      "gpu-1",
      "student.remove",
      expect.objectContaining({
        lab: "bio", username: "dave", delete_data: true,
        removal_id: expect.any(String), cold_cleanup_nodes: ["gpu-1"],
      }),
      "admin",
    );
    expect(sendRemovalEmail).toHaveBeenCalledWith("d@uga.edu", "bio", true);
    expect(students.listMembers(labId).find((m) => m.username === "dave")).toBeUndefined();
  });

  it("throws when the student is not a member", () => {
    expect(() => students.removeStudentFromLab(labId, 999999, false, "admin")).toThrow(/not a member/);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-import-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

vi.mock("../src/lib/mailer", () => ({
  sendCredentialEmail: vi.fn(async () => ({ sent: true })),
  sendRemovalEmail: vi.fn(async () => ({ sent: true })),
}));

let dbmod: typeof import("../src/lib/db");
let imp: typeof import("../src/lib/labimport");
let labsmod: typeof import("../src/lib/labs");

const HEADER = "role,username,email,name,student_id";

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  imp = await import("../src/lib/labimport");
  labsmod = await import("../src/lib/labs");
});

let labId = 0;

beforeEach(() => {
  const d = dbmod.db();
  for (const t of ["placement_members", "lab_members", "lab_placements", "storage_samples", "quota_alerts", "students", "labs"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
  labId = labsmod.createLab({ name: "smith-lab" }).id;
});

const count = (sql: string) => (dbmod.db().prepare(sql).get() as { n: number }).n;

describe("planRosterImport / applyRosterImport", () => {
  it("creates students and adds them to the target lab's roster", async () => {
    const csv = [
      HEADER,
      "student,jdoe,jdoe@x.edu,John Doe,100001",
      "student,asmith,asmith@x.edu,Alice Smith,100002",
    ].join("\n");
    const plan = imp.planRosterImport(labId, csv);
    expect(plan.ok).toBe(true);
    expect(plan.studentsToCreate).toHaveLength(2);
    expect(plan.membershipsToAdd.sort()).toEqual(["asmith", "jdoe"]);

    const res = await imp.applyRosterImport(labId, csv, "admin@x.edu");
    expect(res).toMatchObject({ studentsCreated: 2, membershipsAdded: 2 });
    expect(count(`SELECT COUNT(*) AS n FROM lab_members WHERE lab_id=${labId}`)).toBe(2);
    expect(dbmod.db().prepare("SELECT 1 FROM audit_log WHERE action='lab.roster_import' AND actor='admin@x.edu'").get()).toBeTruthy();
  });

  it("defaults a row with no role column to student", async () => {
    const csv = ["username,email,name,student_id", "alice,alice@x.edu,Alice,1"].join("\n");
    const plan = imp.planRosterImport(labId, csv);
    expect(plan.ok).toBe(true);
    expect(plan.studentsToCreate).toHaveLength(1);
    expect(plan.membershipsToAdd).toEqual(["alice"]);
  });

  it("applies a 'pi' row to the lab's PI metadata without creating a member", async () => {
    const csv = [
      HEADER,
      "pi,,jane@x.edu,Dr. Jane Smith,",
      "student,jdoe,jdoe@x.edu,John Doe,100001",
    ].join("\n");
    const plan = imp.planRosterImport(labId, csv);
    expect(plan.piUpdate).toMatchObject({ piName: "Dr. Jane Smith", piEmail: "jane@x.edu" });
    expect(plan.membershipsToAdd).toEqual(["jdoe"]);

    const res = await imp.applyRosterImport(labId, csv);
    expect(res.piUpdated).toBe(true);
    const lab = dbmod.db().prepare("SELECT pi_name, pi_email FROM labs WHERE id=?").get(labId) as { pi_name: string; pi_email: string };
    expect(lab).toMatchObject({ pi_name: "Dr. Jane Smith", pi_email: "jane@x.edu" });
    expect(count(`SELECT COUNT(*) AS n FROM lab_members WHERE lab_id=${labId}`)).toBe(1);
  });

  it("is idempotent on reimport", async () => {
    const csv = [HEADER, "pi,,pi@x.edu,PI,", "student,alice,alice@x.edu,Alice,1"].join("\n");
    await imp.applyRosterImport(labId, csv);
    const plan2 = imp.planRosterImport(labId, csv);
    expect(plan2.ok).toBe(true);
    expect(plan2.piUpdate).toBeNull();
    expect(plan2.studentsToCreate).toHaveLength(0);
    expect(plan2.studentsToUpdate).toHaveLength(0);
    expect(plan2.membershipsToAdd).toHaveLength(0);
    const res2 = await imp.applyRosterImport(labId, csv);
    expect(res2).toMatchObject({ studentsCreated: 0, membershipsAdded: 0, piUpdated: false });
  });

  it("updates changed student metadata", async () => {
    await imp.applyRosterImport(labId, [HEADER, "student,alice,alice@x.edu,Alice,1"].join("\n"));
    const plan = imp.planRosterImport(labId, [HEADER, "student,alice,alice2@x.edu,Alice Anderson,1"].join("\n"));
    expect(plan.studentsToUpdate).toHaveLength(1);
    expect(plan.studentsToUpdate[0]).toMatchObject({ username: "alice", name: "Alice Anderson", email: "alice2@x.edu" });
    expect(plan.membershipsToAdd).toHaveLength(0); // already a member
  });

  it("reuses an existing global student, adding only a membership to this lab", async () => {
    const labA = labId;
    const labB = labsmod.createLab({ name: "lab-b" }).id;
    await imp.applyRosterImport(labA, [HEADER, "student,jdoe,j@x.edu,J Doe,777"].join("\n"));
    const plan = imp.planRosterImport(labB, [HEADER, "student,jdoe,j@x.edu,J Doe,777"].join("\n"));
    expect(plan.studentsToCreate).toHaveLength(0);
    expect(plan.membershipsToAdd).toEqual(["jdoe"]);
    await imp.applyRosterImport(labB, [HEADER, "student,jdoe,j@x.edu,J Doe,777"].join("\n"));
    expect(count("SELECT COUNT(*) AS n FROM students")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM lab_members")).toBe(2);
  });

  it("flags conflicting PI rows", () => {
    const plan = imp.planRosterImport(labId, [
      HEADER,
      "pi,,a@x.edu,Dr. A,",
      "pi,,b@x.edu,Dr. B,",
    ].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /conflicting PI/.test(c.message))).toBe(true);
  });

  it("flags a student_id reused across two usernames", () => {
    const plan = imp.planRosterImport(labId, [
      HEADER,
      "student,alice,alice@x.edu,Alice,900",
      "student,bob,bob@x.edu,Bob,900",
    ].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /used by two usernames/.test(c.message))).toBe(true);
  });

  it("flags a student_id that already belongs to a different existing username", async () => {
    await imp.applyRosterImport(labId, [HEADER, "student,alice,alice@x.edu,Alice,42"].join("\n"));
    const plan = imp.planRosterImport(labId, [HEADER, "student,bob,bob@x.edu,Bob,42"].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /already belongs to 'alice'/.test(c.message))).toBe(true);
  });

  it("flags unknown roles, invalid emails, and a student row with no username", () => {
    const plan = imp.planRosterImport(labId, [
      HEADER,
      "teacher,carol,carol@x.edu,Carol,",
      "student,dave,not-an-email,Dave,",
      "student,,nouser@x.edu,No Username,123",
    ].join("\n"));
    expect(plan.invalid.some((c) => /unknown role/.test(c.message))).toBe(true);
    expect(plan.invalid.some((c) => /invalid email/.test(c.message))).toBe(true);
    expect(plan.invalid.some((c) => /username required/.test(c.message))).toBe(true);
    expect(plan.ok).toBe(false);
  });

  it("rejects an unknown lab and a missing username column", () => {
    expect(imp.planRosterImport(999999, [HEADER, "student,alice,a@x.edu,Alice,1"].join("\n")).invalid.some((c) => /Unknown lab/.test(c.message))).toBe(true);
    expect(imp.planRosterImport(labId, ["role,email,name,student_id", "student,a@x.edu,Alice,1"].join("\n")).invalid.some((c) => /Missing required column 'username'/.test(c.message))).toBe(true);
  });

  it("enforces the row-count and size limits", () => {
    const rows = [HEADER];
    for (let i = 0; i < imp.MAX_IMPORT_ROWS + 1; i++) rows.push(`student,user${i},u${i}@x.edu,User ${i},`);
    expect(imp.planRosterImport(labId, rows.join("\n")).invalid.some((c) => /Too many rows/.test(c.message))).toBe(true);

    const big = HEADER + "\n" + "x".repeat(imp.MAX_IMPORT_BYTES);
    expect(imp.planRosterImport(labId, big).invalid.some((c) => /File too large/.test(c.message))).toBe(true);
  });

  it("applyRosterImport rolls back entirely when the plan is not committable", async () => {
    const before = count("SELECT COUNT(*) AS n FROM students");
    await expect(
      imp.applyRosterImport(labId, [HEADER, "student,alice,alice@x.edu,Alice,900", "student,bob,bob@x.edu,Bob,900"].join("\n")),
    ).rejects.toThrow(/not committable/);
    expect(count("SELECT COUNT(*) AS n FROM students")).toBe(before); // nothing written
  });
});

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

const HEADER = "lab_name,pi_name,pi_email,student_id,username,student_name,student_email";

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  imp = await import("../src/lib/labimport");
});

beforeEach(() => {
  const d = dbmod.db();
  for (const t of ["placement_members", "lab_members", "lab_placements", "storage_samples", "quota_alerts", "students", "labs"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
});

const count = (sql: string) => (dbmod.db().prepare(sql).get() as { n: number }).n;

describe("planLabImport / applyLabImport", () => {
  it("creates multiple students in one lab plus an empty lab", async () => {
    const csv = [
      HEADER,
      "smith-lab,Dr. Jane Smith,jane@x.edu,100001,jdoe,John Doe,jdoe@x.edu",
      "smith-lab,Dr. Jane Smith,jane@x.edu,100002,asmith,Alice Smith,asmith@x.edu",
      "empty-lab,Dr. Mary Lee,mary@x.edu,,,,",
    ].join("\n");
    const plan = imp.planLabImport(csv);
    expect(plan.ok).toBe(true);
    expect(plan.labsToCreate.map((l) => l.name).sort()).toEqual(["empty-lab", "smith-lab"]);
    expect(plan.studentsToCreate).toHaveLength(2);
    expect(plan.membershipsToAdd).toHaveLength(2);

    const res = await imp.applyLabImport(csv, "admin@x.edu");
    expect(res).toMatchObject({ labsCreated: 2, studentsCreated: 2, membershipsAdded: 2 });
    expect(count("SELECT COUNT(*) AS n FROM labs")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM lab_members")).toBe(2);
    // empty-lab has no members.
    expect(count("SELECT COUNT(*) AS n FROM lab_members WHERE lab_id=(SELECT id FROM labs WHERE name='empty-lab')")).toBe(0);
    // audit row recorded with the actor.
    expect(dbmod.db().prepare("SELECT 1 FROM audit_log WHERE action='lab.import' AND actor='admin@x.edu'").get()).toBeTruthy();
  });

  it("places one student in multiple labs (single student row, two memberships)", async () => {
    const csv = [
      HEADER,
      "lab-a,PI A,a@x.edu,500,shared,Shared S,s@x.edu",
      "lab-b,PI B,b@x.edu,500,shared,Shared S,s@x.edu",
    ].join("\n");
    await imp.applyLabImport(csv);
    expect(count("SELECT COUNT(*) AS n FROM students")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM lab_members")).toBe(2);
  });

  it("is idempotent on reimport", async () => {
    const csv = [HEADER, "bio,PI,pi@x.edu,1,alice,Alice,alice@x.edu"].join("\n");
    await imp.applyLabImport(csv);
    const plan2 = imp.planLabImport(csv);
    expect(plan2.ok).toBe(true);
    expect(plan2.labsToCreate).toHaveLength(0);
    expect(plan2.labsToUpdate).toHaveLength(0);
    expect(plan2.studentsToCreate).toHaveLength(0);
    expect(plan2.studentsToUpdate).toHaveLength(0);
    expect(plan2.membershipsToAdd).toHaveLength(0);
    const res2 = await imp.applyLabImport(csv);
    expect(res2).toMatchObject({ labsCreated: 0, studentsCreated: 0, membershipsAdded: 0 });
  });

  it("updates changed lab PI and student metadata", async () => {
    await imp.applyLabImport([HEADER, "bio,Old PI,old@x.edu,1,alice,Alice,alice@x.edu"].join("\n"));
    const plan = imp.planLabImport([HEADER, "bio,New PI,new@x.edu,1,alice,Alice Anderson,alice2@x.edu"].join("\n"));
    expect(plan.labsToUpdate).toEqual([{ name: "bio", piName: "New PI", piEmail: "new@x.edu" }]);
    expect(plan.studentsToUpdate).toHaveLength(1);
    expect(plan.studentsToUpdate[0]).toMatchObject({ username: "alice", name: "Alice Anderson", email: "alice2@x.edu" });
    await imp.applyLabImport([HEADER, "bio,New PI,new@x.edu,1,alice,Alice Anderson,alice2@x.edu"].join("\n"));
    const lab = dbmod.db().prepare("SELECT pi_name, pi_email FROM labs WHERE name='bio'").get() as any;
    expect(lab).toMatchObject({ pi_name: "New PI", pi_email: "new@x.edu" });
  });

  it("matches an existing student by student_id, adding only a membership", async () => {
    await imp.applyLabImport([HEADER, "lab-a,PI,pi@x.edu,777,jdoe,J Doe,j@x.edu"].join("\n"));
    const plan = imp.planLabImport([HEADER, "lab-b,PI,pi2@x.edu,777,jdoe,J Doe,j@x.edu"].join("\n"));
    expect(plan.studentsToCreate).toHaveLength(0);
    expect(plan.membershipsToAdd).toEqual([{ lab: "lab-b", username: "jdoe" }]);
  });

  it("flags conflicting PI data for one lab", () => {
    const plan = imp.planLabImport([
      HEADER,
      "bio,Dr. A,a@x.edu,1,alice,Alice,alice@x.edu",
      "bio,Dr. B,b@x.edu,2,bob,Bob,bob@x.edu",
    ].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /PI name mismatch/.test(c.message))).toBe(true);
  });

  it("flags a student_id reused across two usernames", () => {
    const plan = imp.planLabImport([
      HEADER,
      "bio,PI,pi@x.edu,900,alice,Alice,alice@x.edu",
      "bio,PI,pi@x.edu,900,bob,Bob,bob@x.edu",
    ].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /used by two usernames/.test(c.message))).toBe(true);
  });

  it("flags a student_id that already belongs to a different existing username", async () => {
    await imp.applyLabImport([HEADER, "bio,PI,pi@x.edu,42,alice,Alice,alice@x.edu"].join("\n"));
    const plan = imp.planLabImport([HEADER, "bio2,PI,pi@x.edu,42,bob,Bob,bob@x.edu"].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.conflicts.some((c) => /already belongs to 'alice'/.test(c.message))).toBe(true);
  });

  it("flags invalid lab names, emails, and missing username", () => {
    const plan = imp.planLabImport([
      HEADER,
      "bad/lab,PI,pi@x.edu,,,,",
      "ok-lab,PI,not-an-email,,,,",
      "ok-lab,PI,pi@x.edu,123,,No Username,nouser@x.edu",
    ].join("\n"));
    expect(plan.invalid.some((c) => /invalid lab_name/.test(c.message))).toBe(true);
    expect(plan.invalid.some((c) => /invalid pi_email/.test(c.message))).toBe(true);
    expect(plan.invalid.some((c) => /username required/.test(c.message))).toBe(true);
    expect(plan.ok).toBe(false);
  });

  it("enforces the row-count and size limits", () => {
    const rows = [HEADER];
    for (let i = 0; i < imp.MAX_IMPORT_ROWS + 1; i++) rows.push(`lab-${i},PI,pi@x.edu,,,,`);
    const overRows = imp.planLabImport(rows.join("\n"));
    expect(overRows.invalid.some((c) => /Too many rows/.test(c.message))).toBe(true);

    const big = HEADER + "\n" + "x".repeat(imp.MAX_IMPORT_BYTES);
    expect(imp.planLabImport(big).invalid.some((c) => /File too large/.test(c.message))).toBe(true);
  });

  it("applyLabImport rolls back entirely when the plan is not committable", async () => {
    const before = count("SELECT COUNT(*) AS n FROM labs");
    await expect(
      imp.applyLabImport([HEADER, "bio,Dr. A,a@x.edu,1,alice,Alice,alice@x.edu", "bio,Dr. B,b@x.edu,2,bob,Bob,bob@x.edu"].join("\n")),
    ).rejects.toThrow(/not committable/);
    expect(count("SELECT COUNT(*) AS n FROM labs")).toBe(before); // nothing written
  });
});

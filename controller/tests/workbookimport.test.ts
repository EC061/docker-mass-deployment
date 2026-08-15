import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-workbook-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

vi.mock("../src/lib/mailer", () => ({
  sendCredentialEmail: vi.fn(async () => ({ sent: true })),
  sendPlacementCompleteEmail: vi.fn(async () => ({ sent: true })),
  sendRemovalEmail: vi.fn(async () => ({ sent: true })),
}));

let dbmod: typeof import("../src/lib/db");
let wb: typeof import("../src/lib/workbookimport");
let labsmod: typeof import("../src/lib/labs");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  wb = await import("../src/lib/workbookimport");
  labsmod = await import("../src/lib/labs");
});

beforeEach(() => {
  const d = dbmod.db();
  for (const t of ["placement_members", "lab_members", "lab_placements", "storage_samples", "quota_alerts", "labs", "students"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
});

const HEADER = ["First Name", "Last Name", "UGA ID", "Email", "MS or PhD"];

/** The department workbook's first two tabs, as lib/xlsx.ts hands them over. */
const SHEETS = () => [
  {
    name: "Geng_Yuan_Lab",
    rows: [
      HEADER,
      ["Geng", "Yuan", "gy23443", "geng.yuan@uga.edu", "Faculty"],
      ["Ningxi", "Cheng", "nc96132", "nc96132@uga.edu", "PhD"],
      ["Qitao", "Tan", "qt97442", "qt97442@uga.edu", "Phd"],
    ],
  },
  {
    name: "Wei_Niu_Lab",
    rows: [
      HEADER,
      ["Wei", "Niu", "wn63790", "wniu@uga.edu", "Faculty"],
      ["Ruqing", "Liu", "rl12687", "rl12687@uga.edu", "PhD"],
    ],
  },
];

const student = (username: string) =>
  dbmod.db().prepare("SELECT * FROM students WHERE username = ?").get(username) as
    | { name: string; first_name: string; last_name: string; degree: string; email: string; student_id: string }
    | undefined;

describe("planWorkbookImport", () => {
  it("maps one lab per sheet and designates the Faculty row as PI", () => {
    const plan = wb.planWorkbookImport(SHEETS());
    expect(plan.ok).toBe(true);
    expect(plan.labs.map((l) => l.lab)).toEqual(["Geng_Yuan_Lab", "Wei_Niu_Lab"]);
    expect(plan.labs.every((l) => !l.labExists)).toBe(true);
    expect(plan.labs[0].piUsername).toBe("gy23443");
    expect(plan.labsToCreate).toBe(2);
    expect(plan.studentsToCreate).toBe(5);
    expect(plan.membersToAdd).toBe(5);
  });

  it("lists the labs and people behind each counter", () => {
    const plan = wb.planWorkbookImport(SHEETS());
    expect(plan.newLabs).toEqual(["Geng_Yuan_Lab", "Wei_Niu_Lab"]);
    expect(plan.accountsToCreate).toHaveLength(plan.studentsToCreate);
    expect(plan.accountsToUpdate).toEqual([]);
    expect(plan.accountsToCreate[0]).toMatchObject({
      username: "gy23443",
      name: "Geng Yuan",
      email: "geng.yuan@uga.edu",
      labs: ["Geng_Yuan_Lab"],
    });
    expect(plan.rosterAdditions).toHaveLength(plan.membersToAdd);
    expect(plan.rosterAdditions[0]).toMatchObject({ username: "gy23443", lab: "Geng_Yuan_Lab", isPi: true, newAccount: true });
  });

  it("counts a person listed on two sheets as one account but two roster additions", () => {
    const sheets = SHEETS();
    sheets[1].rows.push(["Ningxi", "Cheng", "nc96132", "nc96132@uga.edu", "PhD"]);
    const plan = wb.planWorkbookImport(sheets);
    expect(plan.studentsToCreate).toBe(5);
    expect(plan.membersToAdd).toBe(6);
    expect(plan.accountsToCreate.find((a) => a.username === "nc96132")!.labs).toEqual([
      "Geng_Yuan_Lab",
      "Wei_Niu_Lab",
    ]);
    expect(plan.rosterAdditions.filter((m) => m.username === "nc96132").map((m) => m.lab)).toEqual([
      "Geng_Yuan_Lab",
      "Wei_Niu_Lab",
    ]);
  });

  it("marks a roster addition for someone who already has an account", async () => {
    await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    const sheets = SHEETS();
    sheets[1].rows.push(["Ningxi", "Cheng", "nc96132", "nc96132@uga.edu", "PhD"]);
    const plan = wb.planWorkbookImport(sheets);
    expect(plan.studentsToCreate).toBe(0);
    expect(plan.rosterAdditions).toEqual([
      { username: "nc96132", name: "Ningxi Cheng", lab: "Wei_Niu_Lab", isPi: false, newAccount: false },
    ]);
  });

  it("sanitizes a sheet name into a lab name", () => {
    expect(wb.labNameFromSheet(" Geng Yuan Lab! ")).toBe("Geng_Yuan_Lab");
    expect(wb.labNameFromSheet("2025 – Fei Dou")).toBe("2025_Fei_Dou");
    expect(wb.labNameFromSheet("!!!")).toBe("");
  });

  it("rejects duplicate UGA IDs, bad emails and rows without a UGA ID", () => {
    const plan = wb.planWorkbookImport([
      {
        name: "Bad_Lab",
        rows: [
          HEADER,
          ["Ann", "One", "aa11111", "aa11111@uga.edu", "PhD"],
          ["Ann", "Two", "aa11111", "aa2@uga.edu", "PhD"],
          ["Bob", "Three", "bb22222", "not-an-email", "MS"],
          ["Carl", "Four", "", "cc33333@uga.edu", "MS"],
          ["", "", "", "", ""],
        ],
      },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.labs[0].issues.map((i) => i.line)).toEqual([3, 4, 5]);
  });

  it("flags a sheet with no UGA ID column", () => {
    const plan = wb.planWorkbookImport([{ name: "X_Lab", rows: [["Who", "What"], ["a", "b"]] }]);
    expect(plan.ok).toBe(false);
    expect(plan.labs[0].issues[0].message).toMatch(/UGA ID/);
  });

  it("flags two sheets that map to the same lab", () => {
    const plan = wb.planWorkbookImport([
      { name: "Fei_Dou_Lab", rows: [HEADER, ["Dou", "Fei", "fd43514", "fei.dou@uga.edu", "Faculty"]] },
      { name: "Fei Dou Lab", rows: [HEADER, ["Dou", "Fei", "fd43514", "fei.dou@uga.edu", "Faculty"]] },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.issues[0]).toMatch(/both map to lab 'Fei_Dou_Lab'/);
  });

  it("warns rather than fails when a sheet has no Faculty row", () => {
    const plan = wb.planWorkbookImport([
      { name: "No_Pi_Lab", rows: [HEADER, ["Ann", "One", "aa11111", "aa11111@uga.edu", "PhD"]] },
    ]);
    expect(plan.ok).toBe(true);
    expect(plan.labs[0].piUsername).toBeNull();
    expect(plan.labs[0].warnings[0]).toMatch(/no row is marked Faculty/i);
  });
});

describe("applyWorkbookImport", () => {
  it("creates every lab, its PI and its roster from the workbook", async () => {
    const result = await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    expect(result.labsCreated).toEqual(["Geng_Yuan_Lab", "Wei_Niu_Lab"]);
    expect(result.studentsCreated).toBe(5);
    expect(result.membershipsAdded).toBe(5);
    expect(result.pisSet).toBe(2);

    const lab = labsmod.getLabByName("Geng_Yuan_Lab")!;
    expect(lab.pi_name).toBe("Geng Yuan");
    expect(lab.pi_email).toBe("geng.yuan@uga.edu");

    // UGA ID is both the login and the stored student ID; names and standing are stored separately.
    expect(student("nc96132")).toMatchObject({
      first_name: "Ningxi",
      last_name: "Cheng",
      name: "Ningxi Cheng",
      degree: "PhD",
      email: "nc96132@uga.edu",
      student_id: "nc96132",
    });
    // "Phd" is normalized on the way in.
    expect(student("qt97442")!.degree).toBe("PhD");
  });

  it("designates the PI as a protected member", async () => {
    await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    const lab = labsmod.getLabByName("Geng_Yuan_Lab")!;
    const pi = student("gy23443")!;
    expect(lab.pi_student_id).toBe(
      (dbmod.db().prepare("SELECT id FROM students WHERE username = 'gy23443'").get() as { id: number }).id,
    );
    expect(pi.degree).toBe("Faculty");
    const members = dbmod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM lab_members WHERE lab_id = ?")
      .get(lab.id) as { n: number };
    expect(members.n).toBe(3);
  });

  it("is idempotent — re-importing the same workbook changes nothing", async () => {
    await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    const plan = wb.planWorkbookImport(SHEETS());
    expect(plan.ok).toBe(true);
    expect(plan.labsToCreate).toBe(0);
    expect(plan.studentsToCreate).toBe(0);
    expect(plan.studentsToUpdate).toBe(0);
    expect(plan.membersToAdd).toBe(0);

    const again = await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    expect(again.labsCreated).toEqual([]);
    expect(again.membershipsAdded).toBe(0);
    expect((dbmod.db().prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number }).n).toBe(5);
  });

  it("adds new people to an existing lab and refreshes changed details", async () => {
    await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    const updated = SHEETS();
    updated[0].rows.push(["Ci", "Zhang", "cz06540", "cz06540@uga.edu", "MS"]);
    updated[0].rows[2] = ["Ningxi", "Cheng", "nc96132", "edwardcheng@uga.edu", "PhD"];

    const plan = wb.planWorkbookImport(updated);
    expect(plan.labsToCreate).toBe(0);
    expect(plan.studentsToCreate).toBe(1);
    expect(plan.studentsToUpdate).toBe(1);

    const result = await wb.applyWorkbookImport(updated, "admin@uga.edu");
    expect(result.membershipsAdded).toBe(1);
    expect(student("nc96132")!.email).toBe("edwardcheng@uga.edu");
    expect(student("cz06540")!.degree).toBe("MS");
  });

  it("creates a person listed on two sheets once and enrols them in both labs", async () => {
    const sheets = SHEETS();
    sheets[1].rows.push(["Ningxi", "Cheng", "nc96132", "nc96132@uga.edu", "PhD"]);
    const result = await wb.applyWorkbookImport(sheets, "admin@uga.edu");
    expect(result.studentsCreated).toBe(5);
    expect(result.membershipsAdded).toBe(6);
    expect((dbmod.db().prepare("SELECT COUNT(*) AS n FROM students").get() as { n: number }).n).toBe(5);
  });

  it("refuses a workbook that would change an already-provisioned PI", async () => {
    await wb.applyWorkbookImport(SHEETS(), "admin@uga.edu");
    const hijacked = SHEETS();
    hijacked[0].rows[1] = ["Someone", "Else", "se00000", "se00000@uga.edu", "Faculty"];
    const plan = wb.planWorkbookImport(hijacked);
    expect(plan.ok).toBe(false);
    expect(plan.labs[0].issues[0].message).toMatch(/already has PI 'gy23443'/);
    await expect(wb.applyWorkbookImport(hijacked, "admin@uga.edu")).rejects.toThrow(/not importable/);
  });

  it("ignores junk the browser might post", () => {
    const sheets = wb.normalizeWorkbookSheets([
      { name: 42, rows: [["a", null, { x: 1 }, 7]] },
      "nonsense",
      null,
    ]);
    expect(sheets[0]).toEqual({ name: "42", rows: [["a", "", "", "7"]] });
    expect(sheets[1]).toEqual({ name: "", rows: [] });
    expect(wb.normalizeWorkbookSheets("nope")).toEqual([]);
  });
});

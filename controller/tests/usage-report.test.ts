import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-usage-report-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

let dbmod: typeof import("../src/lib/db");
let report: typeof import("../src/lib/usage-report");
let mailer: typeof import("../src/lib/mailer");

const HOUR = 60 * 60 * 1000;

function sample(placementId: number, studentId: number | null, pool: string, used: number, ts: number, quota: number | null = null) {
  dbmod
    .db()
    .prepare("INSERT INTO storage_samples (placement_id, student_id, pool, used_bytes, quota_bytes, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(placementId, studentId, pool, used, quota, ts);
}

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  report = await import("../src/lib/usage-report");
  mailer = await import("../src/lib/mailer");
  const d = dbmod.db();
  d.prepare("INSERT INTO nodes (id, name, online, created_at) VALUES (1, 'node-a', 1, 0)").run();

  // Lab 'bio' on node-a: three students, per-student fast/cold quota shares, one student (carol)
  // with no samples yet, plus live lab-level totals and a shared rootfs sample.
  d.prepare("INSERT INTO labs (id, name, pi_name, pi_email, created_at, updated_at) VALUES (1, 'bio', 'Dr. Smith', 'pi@uga.edu', 0, 0)").run();
  d.prepare(
    `INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, usage_scanned_at, created_at, updated_at)
     VALUES (1, 1, 1, 1000, 4096, 50001, 'img-x', 'active', ?, 0, 0)`,
  ).run(Date.now() - 3 * HOUR);
  d.prepare("INSERT INTO students (id, username, name, email, linux_uid, created_at, updated_at) VALUES (1, 'alice', 'Alice A.', 'alice@uga.edu', 10000, 0, 0)").run();
  d.prepare("INSERT INTO students (id, username, name, email, linux_uid, created_at, updated_at) VALUES (2, 'bob', 'Bob B.', 'bob@uga.edu', 10001, 0, 0)").run();
  d.prepare("INSERT INTO students (id, username, name, email, linux_uid, created_at, updated_at) VALUES (3, 'carol', 'Carol C.', NULL, 10002, 0, 0)").run();
  for (const sid of [1, 2, 3]) d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (1, ?, 0)").run(sid);

  const live = Date.now() - 2 * HOUR;
  sample(1, 1, "fast", 250, live); // alice: 250/1000 = 25%
  sample(1, 1, "cold", 512, live);
  sample(1, 2, "fast", 100, live);
  sample(1, 2, "cold", 200, live);
  // carol: no samples -> "—"
  sample(1, null, "fast", 600, live, 1000); // 60%
  sample(1, null, "cold", 1024, live, 4096); // 25%
  sample(1, null, "rootfs", 2048, live);

  // Lab 'empty' on node-a: a placement with no samples and no per-student scan yet.
  d.prepare("INSERT INTO labs (id, name, created_at, updated_at) VALUES (2, 'empty', 0, 0)").run();
  d.prepare(
    `INSERT INTO lab_placements (id, lab_id, node_id, fast_quota_bytes, cold_quota_bytes, ssh_port, image, state, created_at, updated_at)
     VALUES (2, 2, 1, 1000, 4096, 50002, 'img-x', 'active', 0, 0)`,
  ).run();
  d.prepare("INSERT INTO lab_members (lab_id, student_id, created_at) VALUES (2, 1, 0)").run();
});

describe("buildUsageReport", () => {
  it("returns null for an unknown placement", () => {
    expect(report.buildUsageReport(999)).toBeNull();
  });

  it("renders the header, roster rows, totals, rootfs, and freshness lines", () => {
    const r = report.buildUsageReport(1)!;
    expect(r).not.toBeNull();
    expect(r.labName).toBe("bio");
    expect(r.nodeName).toBe("node-a");
    expect(r.piName).toBe("Dr. Smith");
    expect(r.piEmail).toBe("pi@uga.edu");
    expect(r.students.map((s) => s.username)).toEqual(["alice", "bob", "carol"]);

    const t = r.text;
    expect(t).toContain("Lab 'bio' on node node-a — storage usage");
    // Freshness: live totals 2h ago, per-student scan 3h ago.
    expect(t).toContain("live totals 2h ago");
    expect(t).toContain("per-student scan 3h ago");
    // Per-student shares of the lab's total quota (binary units, floored percent).
    expect(t).toContain("250 B (25%)");
    expect(t).toContain("512 B");
    // TOTAL row + shared rootfs line (not a per-student column).
    expect(t).toContain("TOTAL");
    expect(t).toContain("600 B / 1000 B (60%)"); // fast total
    expect(t).toContain("1.0 KiB / 4.0 KiB (25%)"); // cold total (1024 / 4096 bytes, binary units)
    expect(t).toContain("ROOTFS (shared)  2.0 KiB");
    // The table has no per-student ROOTFS column.
    expect(t).not.toContain("ROOTFS (shared)  —");
  });

  it("shows a dash for a roster member with no samples yet", () => {
    const t = report.buildUsageReport(1)!.text;
    const carolLine = t.split("\n").find((l) => l.includes("carol"))!;
    expect(carolLine).toContain("—");
    expect(carolLine).not.toContain("(you)");
  });

  it("marks only the highlighted student's row with (you)", () => {
    const plain = report.buildUsageReport(1)!.text;
    expect(plain).not.toContain("(you)");
    const highlighted = report.buildUsageReport(1, { highlightStudentId: 1 })!.text;
    const aliceLine = highlighted.split("\n").find((l) => l.includes("alice"))!;
    expect(aliceLine).toContain("alice  (you)");
    const bobLine = highlighted.split("\n").find((l) => l.includes("bob"))!;
    expect(bobLine).not.toContain("(you)");
  });

  it("still builds a report when there are no lab-level samples, making it explicit", () => {
    const r = report.buildUsageReport(2)!;
    expect(r).not.toBeNull();
    const t = r.text;
    expect(t).toContain("live totals never");
    expect(t).toContain("per-student scan never");
    expect(t).toContain("(no live lab totals have been reported yet)");
    // TOTAL row and rootfs fall back to dashes.
    expect(t).toContain("ROOTFS (shared)  —");
  });
});

describe("renderUsageReportEmail", () => {
  it("substitutes {name} {lab} {node} {report} in the student template", () => {
    const out = mailer.renderUsageReportEmail("student", {
      name: "Alice A.",
      lab: "bio",
      node: "node-a",
      report: "USAGE-TABLE",
    });
    expect(out.subject).toBe("[bio] Please review your storage usage on node-a");
    expect(out.body).toContain("Hi Alice A.,");
    expect(out.body).toContain('marked "(you)"');
    expect(out.body).toContain("USAGE-TABLE");
    expect(out.body).toContain("lab 'bio' on node node-a");
  });

  it("substitutes placeholders in the PI template", () => {
    const out = mailer.renderUsageReportEmail("pi", {
      name: "Dr. Smith",
      lab: "bio",
      node: "node-a",
      report: "USAGE-TABLE",
    });
    expect(out.subject).toBe("[bio] Lab storage usage report — node-a");
    expect(out.body).toContain("Hi Dr. Smith,");
    expect(out.body).toContain("your lab 'bio' on node node-a");
    expect(out.body).toContain("USAGE-TABLE");
  });

  it("honors an admin-editable override template", async () => {
    const settings = await import("../src/lib/settings");
    settings.setSetting("usageReportStudentSubject", "hi {name}");
    settings.setSetting("usageReportStudentBody", "{lab}/{node}: {report}");
    const out = mailer.renderUsageReportEmail("student", { name: "Al", lab: "bio", node: "n1", report: "T" });
    expect(out.subject).toBe("hi Al");
    expect(out.body).toBe("bio/n1: T");
    settings.setSetting("usageReportStudentSubject", "");
    settings.setSetting("usageReportStudentBody", "");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-scrub-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// Capture enqueued tasks instead of touching the honker queue.
const enqueueTask = vi.fn(() => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));

// Count admin alerts instead of really sending email.
const sendMail = vi.fn(async () => ({ sent: true }));
vi.mock("../src/lib/mailer", () => ({ sendMail, sendQuotaEmail: vi.fn(async () => ({ sent: true })) }));

let dbmod: typeof import("../src/lib/db");
let maintenance: typeof import("../src/lib/maintenance");
let ingest: typeof import("../src/lib/ingest");
let settings: typeof import("../src/lib/settings");

function addNode(name: string, caps: object, lastScrub: number | null = null) {
  dbmod
    .db()
    .prepare(
      "INSERT INTO nodes (name, online, capabilities, last_scrub, created_at) VALUES (?, 1, ?, ?, 0)",
    )
    .run(name, JSON.stringify(caps), lastScrub);
}

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  maintenance = await import("../src/lib/maintenance");
  ingest = await import("../src/lib/ingest");
  settings = await import("../src/lib/settings");
  dbmod
    .db()
    .prepare("INSERT INTO admins (name, email, password_hash, created_at) VALUES ('A','a@uga.edu','x',0)")
    .run();
});

describe("scrub scheduling", () => {
  it("does nothing when disabled", () => {
    enqueueTask.mockClear();
    settings.setSetting("scrubEnabled", false);
    addNode("disabled-node", { zfs: true });
    expect(maintenance.scheduleScrubs()).toEqual([]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("scrubs due ZFS nodes, skips non-ZFS and recently-scrubbed nodes", () => {
    enqueueTask.mockClear();
    settings.setSetting("scrubEnabled", true);
    settings.setSetting("scrubIntervalDays", 30);
    const now = 1_000_000_000_000;
    addNode("zfs-due", { zfs: true }, null); // never scrubbed -> due
    addNode("smb-only", { zfs: false }, null); // no ZFS -> skip
    addNode("recent", { zfs: true }, now - 1 * 86400 * 1000); // 1 day ago -> not due

    const scheduled = maintenance.scheduleScrubs(now);
    expect(scheduled).toContain("zfs-due");
    expect(scheduled).not.toContain("smb-only");
    expect(scheduled).not.toContain("recent");
    expect(enqueueTask).toHaveBeenCalledWith("zfs-due", "node.scrub", {}, "scrub-scheduler");
    // last_scrub is stamped so the next tick won't re-scrub immediately.
    const row = dbmod.db().prepare("SELECT last_scrub FROM nodes WHERE name = 'zfs-due'").get() as {
      last_scrub: number;
    };
    expect(row.last_scrub).toBe(now);
  });
});

describe("scrub status ingestion", () => {
  it("stores status and alerts when a pool newly reports errors", async () => {
    sendMail.mockClear();
    addNode("ingest-node", { zfs: true });
    ingest.ingestTelemetry("ingest-node", {
      pools: [],
      scrub: [
        { pool: "fast", healthy: true, errors: 0 },
        { pool: "slow", healthy: false, errors: 3, detail: "state=DEGRADED; errors=3" },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMail).toHaveBeenCalledTimes(1); // one bad pool -> one alert

    const errLog = dbmod
      .db()
      .prepare("SELECT count(*) AS c FROM logs WHERE node = 'ingest-node' AND source = 'scrub' AND level = 'ERROR'")
      .get() as { c: number };
    expect(errLog.c).toBe(1);

    const node = dbmod.db().prepare("SELECT scrub_status FROM nodes WHERE name = 'ingest-node'").get() as {
      scrub_status: string;
    };
    expect(JSON.parse(node.scrub_status)).toHaveLength(2);
  });

  it("does not re-alert for an already-bad pool", async () => {
    sendMail.mockClear();
    // Same bad status again -> no new alert/log.
    ingest.ingestTelemetry("ingest-node", {
      pools: [],
      scrub: [
        { pool: "fast", healthy: true, errors: 0 },
        { pool: "slow", healthy: false, errors: 3 },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMail).not.toHaveBeenCalled();
    const errLog = dbmod
      .db()
      .prepare("SELECT count(*) AS c FROM logs WHERE node = 'ingest-node' AND source = 'scrub'")
      .get() as { c: number };
    expect(errLog.c).toBe(1); // still just the one from before
  });
});

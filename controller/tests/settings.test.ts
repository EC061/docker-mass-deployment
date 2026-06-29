import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-settings-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "t";
process.env.AGENT_TOKEN = "t";
process.env.SESSION_SECRET = "test-session-secret-test-session";

const enqueueTask = vi.fn((..._args: unknown[]) => ({ id: "x" }));
vi.mock("../src/lib/queue", () => ({ enqueueTask }));

let dbmod: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");

beforeAll(async () => {
  dbmod = await import("../src/lib/db");
  settings = await import("../src/lib/settings");
});

beforeEach(() => {
  enqueueTask.mockClear();
});

describe("getSetting / setSetting", () => {
  it("returns the typed default when unset", () => {
    expect(settings.getSetting("fastQuotaDefaultBytes")).toBe(2 * settings.TIB);
    expect(settings.getSetting("alertLevel")).toBe("ERROR");
    // Nightly per-student usage-scan defaults (enabled, midnight UTC).
    expect(settings.getSetting("usageScanEnabled")).toBe(true);
    expect(settings.getSetting("usageScanHour")).toBe(0);
  });

  it("roundtrips a value through JSON", () => {
    settings.setSetting("quotaAlertPct", 75);
    expect(settings.getSetting("quotaAlertPct")).toBe(75);
    settings.setSetting("gpuEnabled", true);
    expect(settings.getSetting("gpuEnabled")).toBe(true);
  });

  it("encrypts credential settings at rest but reads them back plaintext (M-05)", () => {
    settings.setSetting("smtpPass", "super-secret-pw");
    settings.setSetting("webdavPass", "dav-secret");
    // getSetting decrypts transparently.
    expect(settings.getSetting("smtpPass")).toBe("super-secret-pw");
    expect(settings.getSetting("webdavPass")).toBe("dav-secret");
    // The raw stored value must NOT contain the plaintext.
    const raw = dbmod.db().prepare("SELECT value FROM settings WHERE key = 'smtpPass'").get() as {
      value: string;
    };
    expect(raw.value).not.toContain("super-secret-pw");
    expect(raw.value).toContain("enc:v1:");
  });

  it("falls back to default when the stored value is corrupt JSON", () => {
    dbmod
      .db()
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('usageScanHour', 'not json') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run();
    expect(settings.getSetting("usageScanHour")).toBe(0);
  });
});

describe("getSettings", () => {
  it("returns every key, merging stored values over defaults", () => {
    settings.setSetting("sshPortStart", 40000);
    const all = settings.getSettings();
    expect(Object.keys(all).length).toBe(Object.keys(settings.DEFAULT_SETTINGS).length);
    expect(all.sshPortStart).toBe(40000);
    expect(all.smtpPort).toBe(587); // default preserved
  });
});

describe("configuration helpers", () => {
  it("isSmtpConfigured needs both host and from", () => {
    settings.setSetting("smtpHost", "");
    settings.setSetting("smtpFrom", "");
    expect(settings.isSmtpConfigured()).toBe(false);
    settings.setSetting("smtpHost", "smtp.uga.edu");
    expect(settings.isSmtpConfigured()).toBe(false);
    settings.setSetting("smtpFrom", "labs@uga.edu");
    expect(settings.isSmtpConfigured()).toBe(true);
  });

  it("webdavConfig composes <url>/<baseDir>/<env>, normalising slashes", () => {
    settings.setSetting("webdavUrl", "");
    expect(settings.isWebdavConfigured()).toBe(false);
    settings.setSetting("webdavUrl", "https://dav.example/labmgr/");
    settings.setSetting("webdavBaseDir", "/backups/");
    settings.setSetting("webdavUser", "bob");
    settings.setSetting("webdavPass", "pw");
    expect(settings.isWebdavConfigured()).toBe(true);
    // env is "dev" outside NODE_ENV=production (see backupEnv()).
    expect(settings.backupEnv()).toBe("dev");
    expect(settings.webdavConfig()).toEqual({
      url: "https://dav.example/labmgr/backups/dev",
      user: "bob",
      pass: "pw",
    });
  });
});

describe("gpuPolicyPayload", () => {
  it("parses comma-separated whitelists, trimming and dropping blanks", () => {
    settings.setSetting("gpuEnabled", true);
    settings.setSetting("gpuUtilThreshold", 8);
    settings.setSetting("gpuIdleMinutes", 15);
    settings.setSetting("gpuWhitelistUsers", " root , admin ,, ");
    settings.setSetting("gpuWhitelistLabs", "bio");
    const payload = settings.gpuPolicyPayload();
    expect(payload).toMatchObject({
      enabled: true,
      util_threshold: 8,
      idle_minutes: 15,
      whitelist_users: ["root", "admin"],
      whitelist_labs: ["bio"],
    });
  });
});

describe("broadcastGpuPolicy", () => {
  it("enqueues gpu.policy.update to every known node", () => {
    dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('n1', 1, 0)").run();
    dbmod.db().prepare("INSERT INTO nodes (name, online, created_at) VALUES ('n2', 0, 0)").run();
    settings.broadcastGpuPolicy("admin");
    expect(enqueueTask).toHaveBeenCalledTimes(2);
    const nodes = enqueueTask.mock.calls.map((c) => c[0]).sort();
    expect(nodes).toEqual(["n1", "n2"]);
    expect(enqueueTask.mock.calls[0][1]).toBe("gpu.policy.update");
    expect(enqueueTask.mock.calls[0][3]).toBe("admin");
  });
});

// SSH-port allocation moved to placements.nextSshPortForNode (per node) — see placements.test.ts.

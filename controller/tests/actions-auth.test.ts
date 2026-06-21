import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Configure env before importing modules that read it at load time.
const tmp = mkdtempSync(join(tmpdir(), "lab-ctl-actions-"));
process.env.DB_PATH = join(tmp, "controller.db");
process.env.SIGNUP_TOKEN = "test-signup";
process.env.AGENT_TOKEN = "test-agent";
process.env.SESSION_SECRET = "test-session-secret-test-session";

// No session cookie -> currentAdmin() returns null -> requireAdmin() must redirect/throw.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe("Server Actions reject unauthenticated callers", () => {
  let labs: typeof import("../src/app/(app)/labs/actions.js");
  let students: typeof import("../src/app/(app)/students/actions.js");
  let settings: typeof import("../src/app/(app)/settings/actions.js");

  beforeAll(async () => {
    labs = await import("../src/app/(app)/labs/actions.js");
    students = await import("../src/app/(app)/students/actions.js");
    settings = await import("../src/app/(app)/settings/actions.js");
  });

  const fd = () => new FormData();

  it("every gated action redirects to /login with no session", async () => {
    const calls: Array<Promise<unknown>> = [
      labs.createLabAction(fd()),
      labs.setQuotaAction(fd()),
      labs.destroyLabAction(fd()),
      labs.rescanAction(fd()),
      labs.recreateContainerAction(fd()),
      labs.addMemberAction(fd()),
      labs.removeMemberAction(fd()),
      students.importCsvAction(fd()),
      settings.saveStorageSettingsAction(fd()),
      settings.saveSmtpSettingsAction(fd()),
      settings.saveAlertSettingsAction(fd()),
      settings.saveGpuPolicyAction(fd()),
      settings.saveScrubSettingsAction(fd()),
      settings.scrubNowAction(),
      settings.saveWebdavSettingsAction(fd()),
      settings.backupNowAction(),
      settings.restoreAction(fd()),
      settings.testEmailAction(fd()),
    ];
    for (const c of calls) {
      await expect(c).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    }
  });
});

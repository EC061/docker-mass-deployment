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
  let templates: typeof import("../src/app/(app)/email-templates/actions.js");
  let backups: typeof import("../src/app/(app)/backups/actions.js");
  let stats: typeof import("../src/app/(app)/stats/actions.js");
  let gpu: typeof import("../src/app/(app)/gpu/actions.js");

  beforeAll(async () => {
    labs = await import("../src/app/(app)/labs/actions.js");
    students = await import("../src/app/(app)/students/actions.js");
    settings = await import("../src/app/(app)/settings/actions.js");
    templates = await import("../src/app/(app)/email-templates/actions.js");
    backups = await import("../src/app/(app)/backups/actions.js");
    stats = await import("../src/app/(app)/stats/actions.js");
    gpu = await import("../src/app/(app)/gpu/actions.js");
  });

  const fd = () => new FormData();

  it("every gated action redirects to /login with no session", async () => {
    const calls: Array<Promise<unknown>> = [
      labs.createLabAction(fd()),
      labs.updateLabMetaAction(fd()),
      labs.destroyLabAction(fd()),
      labs.grantNodeAccessAction(fd()),
      labs.setPlacementQuotaAction(fd()),
      labs.recreatePlacementAction(fd()),
      labs.retryPlacementAction(fd()),
      labs.revealPlacementCredentialAction(fd()),
      labs.removePlacementAction(fd()),
      labs.addMemberAction(fd()),
      labs.removeMemberAction(fd()),
      stats.usageScanAction(fd()),
      stats.emailUsageReportAction(fd()),
      gpu.clearGpuEventsAction(),
      students.importStudentsAction({ labId: 1, rows: [] }),
      settings.saveStorageSettingsAction(fd()),
      settings.saveUsageScanSettingsAction(fd()),
      settings.saveSmtpSettingsAction(fd()),
      settings.saveAlertSettingsAction(fd()),
      settings.saveGpuPolicyAction(fd()),
      settings.saveScrubSettingsAction(fd()),
      settings.scrubNowAction(),
      settings.testEmailAction(fd()),
      templates.saveWelcomeEmailAction(fd()),
      templates.saveGpuWarnEmailAction(fd()),
      templates.saveGpuKillEmailAction(fd()),
      templates.saveRemovalEmailAction(fd()),
      templates.saveQuotaEmailAction(fd()),
      templates.saveUsageReportStudentEmailAction(fd()),
      templates.saveUsageReportPiEmailAction(fd()),
      templates.saveTestEmailAction(fd()),
      templates.createAnnouncementTemplateAction(fd()),
      templates.updateAnnouncementTemplateAction(fd()),
      templates.deleteAnnouncementTemplateAction(fd()),
      backups.saveWebdavSettingsAction(fd()),
      backups.saveScheduleAction(fd()),
      backups.testConnectionAction(),
      backups.backupNowAction(),
      backups.restoreAction(fd()),
      backups.refreshAction(),
    ];
    for (const c of calls) {
      await expect(c).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    }
  });
});

import { Suspense, cache } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Database,
  HardDriveDownload,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Server,
  XCircle,
} from "lucide-react";
import { backupEnv, getSettings, isWebdavConfigured } from "@/lib/settings";
import { webdavStatus } from "@/lib/backup";
import { nextBackupRun } from "@/lib/maintenance";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientTime } from "./_components/ClientTime";
import { SubmitButton } from "./_components/SubmitButton";
import {
  backupNowAction,
  refreshAction,
  restoreAction,
  saveScheduleAction,
  saveWebdavSettingsAction,
  testConnectionAction,
} from "./actions";

// Common IANA timezones for the schedule picker (free text still allowed via the datalist).
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export const dynamic = "force-dynamic";

// Shared, request-scoped: the live status badge and the backup list both read this, but it issues a
// single PROPFIND per render thanks to cache().
const loadStatus = cache(webdavStatus);

function Checking({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </span>
  );
}

/** Live WebDAV connection state, streamed in after the shell paints. */
async function WebdavStatusBadge() {
  const st = await loadStatus();
  if (!st.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" /> Not configured
      </span>
    );
  }
  if (st.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
        <CheckCircle2 className="h-4 w-4" /> Connected — {st.backups.length} backup
        {st.backups.length === 1 ? "" : "s"} available
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 text-sm text-destructive">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> Unreachable — {st.error}
    </span>
  );
}

/** The available-backups table, gated on actual reachability so failures aren't shown as "empty". */
async function BackupsList() {
  const st = await loadStatus();
  if (!st.configured) {
    return (
      <p className="text-sm text-muted-foreground">Configure a WebDAV target above to see backups.</p>
    );
  }
  if (!st.ok) {
    return <p className="text-sm text-destructive">Could not list backups: {st.error}</p>;
  }
  if (st.backups.length === 0) {
    return <p className="text-sm text-muted-foreground">No backups found.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Backup</TableHead>
          <TableHead>Taken</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {st.backups.map((b) => (
          <TableRow key={b.name}>
            <TableCell className="font-mono text-xs">{b.name}</TableCell>
            <TableCell className="text-sm">
              <ClientTime ts={b.stamp} />
            </TableCell>
            <TableCell className="text-right">
              <form action={restoreAction}>
                <input type="hidden" name="name" value={b.name} />
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  icon={<HardDriveDownload />}
                  pendingText="Staging…"
                >
                  Stage restore
                </SubmitButton>
              </form>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function BackupsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const s = getSettings();
  const env = backupEnv();
  const nextRun = nextBackupRun();
  const configured = isWebdavConfigured();

  const anchor = `${String(s.backupAnchorHour).padStart(2, "0")}:${String(
    s.backupAnchorMinute,
  ).padStart(2, "0")}`;
  const failed = s.backupLastStatus === "failed";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
      {msg && <p className="text-sm text-primary">{msg}</p>}

      {/* Status */}
      <Card>
        <CardContent className="space-y-2">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Clock className="h-4 w-4" /> Status
          </h3>
          <p className="text-sm">
            <span className="font-medium">Connection: </span>
            {configured ? (
              <Suspense fallback={<Checking label="Checking connection…" />}>
                <WebdavStatusBadge />
              </Suspense>
            ) : (
              <span className="text-muted-foreground">not configured</span>
            )}
          </p>
          <p className="text-sm">
            <span className="font-medium">Last run: </span>
            <ClientTime ts={s.backupLastRun} />
            {s.backupLastStatus && (
              <span className={failed ? "text-destructive" : "text-emerald-500"}>
                {" "}
                ({failed ? "FAILED" : "OK"})
              </span>
            )}
          </p>
          <p className="text-sm">
            <span className="font-medium">Next run: </span>
            {nextRun ? <ClientTime ts={nextRun} /> : <span className="text-muted-foreground">disabled</span>}
          </p>
          {failed && s.backupLastError && (
            <p className="text-sm text-destructive">Last error: {s.backupLastError}</p>
          )}
        </CardContent>
      </Card>

      {/* WebDAV connection */}
      <Card>
        <CardContent className="space-y-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Server className="h-4 w-4" /> WebDAV connection
          </h3>
          <form action={saveWebdavSettingsAction} className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>WebDAV URL</Label>
              <Input name="webdavUrl" defaultValue={s.webdavUrl} placeholder="https://dav.example.com/db-backup" />
            </div>
            <div>
              <Label>Username</Label>
              <Input name="webdavUser" defaultValue={s.webdavUser} />
            </div>
            <div>
              <Label>Password</Label>
              <Input name="webdavPass" type="password" placeholder={s.webdavPass ? "•••••••• (unchanged)" : ""} />
            </div>
            <div className="sm:col-span-2">
              <Label>Base directory</Label>
              <Input name="webdavBaseDir" defaultValue={s.webdavBaseDir} placeholder="/backups" />
              <p className="pt-1 text-xs text-muted-foreground">
                Backups are written under <code>{s.webdavBaseDir.replace(/\/+$/, "")}/prod</code> and{" "}
                <code>{s.webdavBaseDir.replace(/\/+$/, "")}/dev</code>.
              </p>
            </div>
            <div className="sm:col-span-2">
              <SubmitButton icon={<Save />} pendingText="Saving…">
                Save configuration
              </SubmitButton>
            </div>
          </form>
          {/* Test / Backup act on the saved settings (not the fields above), so they get their own
              forms — that keeps each button's pending spinner independent. */}
          <div className="flex flex-wrap items-center gap-2">
            <form action={testConnectionAction}>
              <SubmitButton variant="outline" icon={<Server />} pendingText="Testing…">
                Test connection
              </SubmitButton>
            </form>
            <form action={backupNowAction}>
              <SubmitButton variant="outline" icon={<Play />} pendingText="Backing up…">
                Backup now
              </SubmitButton>
            </form>
          </div>
        </CardContent>
      </Card>

      {/* Schedule & retention */}
      <Card>
        <CardContent className="space-y-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Clock className="h-4 w-4" /> Schedule &amp; retention
          </h3>
          <form action={saveScheduleAction} className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name="backupEnabled"
                defaultChecked={s.backupEnabled}
                className="accent-primary"
              />
              Enable scheduled backups
            </label>

            <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label>Every (hours)</Label>
                <Input name="backupIntervalHours" type="number" min={1} defaultValue={s.backupIntervalHours} />
              </div>
              <div>
                <Label>Anchor time</Label>
                <Input name="backupAnchor" type="time" defaultValue={anchor} />
              </div>
              <div>
                <Label>Timezone</Label>
                <Input name="backupTimezone" defaultValue={s.backupTimezone} list="backup-tz-list" placeholder="UTC" />
                <datalist id="backup-tz-list">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Default is daily at 02:00 America/New_York (handles EST/EDT).
            </p>

            <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <Label>Keep recent</Label>
                <Input name="backupKeepRecent" type="number" min={0} defaultValue={s.backupKeepRecent} />
              </div>
              <div>
                <Label>Keep weekly</Label>
                <Input name="backupKeepWeekly" type="number" min={0} defaultValue={s.backupKeepWeekly} />
              </div>
              <div>
                <Label>Keep monthly</Label>
                <Input name="backupKeepMonthly" type="number" min={0} defaultValue={s.backupKeepMonthly} />
              </div>
              <div>
                <Label>Keep yearly</Label>
                <Input name="backupKeepYearly" type="number" min={0} defaultValue={s.backupKeepYearly} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Grandfather-father-son retention: keep the newest N, plus the newest in each of the last
              N weeks, months, and years.
            </p>

            <SubmitButton icon={<Save />} pendingText="Saving…">
              Save configuration
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* Available backups */}
      <Card>
        <CardContent className="space-y-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Database className="h-4 w-4" /> Available backups ({env})
          </h3>
          <form action={refreshAction}>
            <SubmitButton variant="outline" size="sm" icon={<RefreshCw />} pendingText="Refreshing…">
              Refresh
            </SubmitButton>
          </form>
          <Suspense fallback={<Checking label="Loading backups…" />}>
            <BackupsList />
          </Suspense>
          <p className="text-xs text-muted-foreground">
            Restoring stages the backup; it replaces the live database on the next service restart.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

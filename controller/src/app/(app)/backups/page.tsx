import { Clock, Database, HardDriveDownload, Play, RefreshCw, Save, Server } from "lucide-react";
import { backupEnv, getSettings, isWebdavConfigured } from "@/lib/settings";
import { listBackups, type BackupEntry } from "@/lib/backup";
import { nextBackupRun } from "@/lib/maintenance";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientTime } from "./_components/ClientTime";
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

export default async function BackupsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const s = getSettings();
  const env = backupEnv();
  const nextRun = nextBackupRun();

  let backups: BackupEntry[] = [];
  if (isWebdavConfigured()) {
    try {
      backups = await listBackups();
    } catch {
      backups = [];
    }
  }

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
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit">
                <Save /> Save configuration
              </Button>
              <Button type="submit" formAction={testConnectionAction} variant="outline">
                <Server /> Test connection
              </Button>
              <Button type="submit" formAction={backupNowAction} variant="outline">
                <Play /> Backup now
              </Button>
            </div>
          </form>
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

            <Button type="submit">
              <Save /> Save configuration
            </Button>
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
            <Button type="submit" variant="outline" size="sm">
              <RefreshCw /> Refresh
            </Button>
          </form>
          {backups.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Backup</TableHead>
                    <TableHead>Taken</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map((b) => (
                    <TableRow key={b.name}>
                      <TableCell className="font-mono text-xs">{b.name}</TableCell>
                      <TableCell className="text-sm">
                        <ClientTime ts={b.stamp} />
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={restoreAction}>
                          <input type="hidden" name="name" value={b.name} />
                          <Button type="submit" variant="secondary" size="sm">
                            <HardDriveDownload /> Stage restore
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">
                Restoring stages the backup; it replaces the live database on the next service restart.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">No backups found.</p>
              <p className="text-xs text-muted-foreground">
                Restoring stages the backup; it replaces the live database on the next service restart.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

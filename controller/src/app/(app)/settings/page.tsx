import { listBackups } from "@/lib/backup";
import { getSettings, GPU_EMAIL_VARS, isWebdavConfigured, TIB, WELCOME_EMAIL_VARS } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  backupNowAction,
  restoreAction,
  saveAlertSettingsAction,
  saveGpuEmailsAction,
  saveGpuPolicyAction,
  saveScrubSettingsAction,
  saveSmtpSettingsAction,
  saveStorageSettingsAction,
  saveWebdavSettingsAction,
  saveWelcomeEmailAction,
  scrubNowAction,
  testEmailAction,
} from "./actions";

// A short list of common IANA timezones for the scrub schedule picker (free text still allowed).
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

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ smtp?: string; backup?: string; scrub?: string }>;
}) {
  const { smtp, backup, scrub } = await searchParams;
  const s = getSettings();
  let backups: string[] = [];
  if (isWebdavConfigured()) {
    try {
      backups = await listBackups();
    } catch {
      backups = [];
    }
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Storage &amp; ports</h3>
          <form action={saveStorageSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Default fast quota (TB)</Label>
              <Input name="fastTb" type="number" step="0.5" defaultValue={s.fastQuotaDefaultBytes / TIB} />
            </div>
            <div>
              <Label>Default slow quota (TB)</Label>
              <Input name="slowTb" type="number" step="0.5" defaultValue={s.slowQuotaDefaultBytes / TIB} />
            </div>
            <div>
              <Label>SSH port range start</Label>
              <Input name="sshPortStart" type="number" defaultValue={s.sshPortStart} />
            </div>
            <div>
              <Label>SSH port range end</Label>
              <Input name="sshPortEnd" type="number" defaultValue={s.sshPortEnd} />
            </div>
            <div>
              <Label>Old-file threshold (days)</Label>
              <Input name="oldFileThresholdDays" type="number" defaultValue={s.oldFileThresholdDays} />
            </div>
            <div>
              <Label>Old-file scan interval (days)</Label>
              <Input name="oldFileScanIntervalDays" type="number" defaultValue={s.oldFileScanIntervalDays} />
            </div>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="oldFileScanEnabled"
                  defaultChecked={s.oldFileScanEnabled}
                  className="accent-primary"
                />
                Run nightly old-file scans automatically
              </label>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Email (external SMTP)</h3>
          {smtp && <p className="text-sm text-primary">{smtp}</p>}
          <form action={saveSmtpSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>SMTP host</Label>
              <Input name="smtpHost" defaultValue={s.smtpHost} placeholder="https://smtp.uga.edu:465" />
              <small className="text-xs text-muted-foreground">
                Use https:// (or port 465) for implicit TLS; http:// for STARTTLS.
              </small>
            </div>
            <div>
              <Label>Port</Label>
              <Input name="smtpPort" type="number" defaultValue={s.smtpPort} />
            </div>
            <div>
              <Label>Username</Label>
              <Input name="smtpUser" defaultValue={s.smtpUser} />
            </div>
            <div>
              <Label>Password</Label>
              <Input name="smtpPass" type="password" placeholder={s.smtpPass ? "•••••• (unchanged)" : ""} />
            </div>
            <div>
              <Label>From address</Label>
              <Input name="smtpFrom" defaultValue={s.smtpFrom} placeholder="labs@uga.edu" />
            </div>
            <div>
              <Label>SSH host override (optional)</Label>
              <Input name="sshHostOverride" defaultValue={s.sshHostOverride} placeholder="gpu.uga.edu" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save SMTP</Button>
            </div>
          </form>
          <form action={testEmailAction} className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Send test email to</Label>
              <Input name="to" type="email" placeholder="you@uga.edu" />
            </div>
            <Button type="submit" variant="secondary">
              Send test
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Welcome email template</h3>
            <p className="text-xs text-muted-foreground">
              Sent to a student (with an email on file) when they are added to a lab. Use{" "}
              <code>{"{placeholder}"}</code> tokens below; unknown tokens are left as-is. Leave a field
              blank to use the built-in default.
            </p>
          </div>
          <form action={saveWelcomeEmailAction} className="grid max-w-2xl gap-3">
            <div>
              <Label>Subject</Label>
              <Input name="welcomeEmailSubject" defaultValue={s.welcomeEmailSubject} />
            </div>
            <div>
              <Label>Body</Label>
              <Textarea name="welcomeEmailBody" rows={16} defaultValue={s.welcomeEmailBody} className="font-mono text-xs" />
            </div>
            <div>
              <Label>Available variables</Label>
              <ul className="m-0 list-disc pl-5 text-xs text-muted-foreground">
                {WELCOME_EMAIL_VARS.map((v) => (
                  <li key={v.key}>
                    <code>{`{${v.key}}`}</code> — {v.desc}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Button type="submit">Save template</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">GPU idle policy</h3>
          <form action={saveGpuPolicyAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="gpuEnabled" defaultChecked={s.gpuEnabled} className="accent-primary" />
              Enable idle killer
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="gpuImmediate" defaultChecked={s.gpuImmediate} className="accent-primary" />
              Kill immediately (no grace)
            </label>
            <div>
              <Label>Idle util threshold (%)</Label>
              <Input name="gpuUtilThreshold" type="number" defaultValue={s.gpuUtilThreshold} />
            </div>
            <div>
              <Label>Idle minutes before warning</Label>
              <Input name="gpuIdleMinutes" type="number" defaultValue={s.gpuIdleMinutes} />
            </div>
            <div>
              <Label>Grace minutes before kill</Label>
              <Input name="gpuGraceMinutes" type="number" defaultValue={s.gpuGraceMinutes} />
            </div>
            <div />
            <div>
              <Label>Whitelist users (comma-sep)</Label>
              <Input name="gpuWhitelistUsers" defaultValue={s.gpuWhitelistUsers} placeholder="alice,bob" />
            </div>
            <div>
              <Label>Whitelist labs (comma-sep)</Label>
              <Input name="gpuWhitelistLabs" defaultValue={s.gpuWhitelistLabs} placeholder="bio,chem" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save &amp; push to nodes</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">GPU notification emails</h3>
            <p className="text-xs text-muted-foreground">
              Emailed to a student (with an email on file) when the idle killer warns about or
              terminates their GPU process. Use <code>{"{placeholder}"}</code> tokens below; unknown
              tokens are left as-is. Leave a field blank to use the built-in default.
            </p>
          </div>
          <form action={saveGpuEmailsAction} className="grid max-w-2xl gap-3">
            <div>
              <Label>Warning email subject</Label>
              <Input name="gpuWarnEmailSubject" defaultValue={s.gpuWarnEmailSubject} />
            </div>
            <div>
              <Label>Warning email body</Label>
              <Textarea name="gpuWarnEmailBody" rows={8} defaultValue={s.gpuWarnEmailBody} className="font-mono text-xs" />
            </div>
            <div>
              <Label>Termination email subject</Label>
              <Input name="gpuKillEmailSubject" defaultValue={s.gpuKillEmailSubject} />
            </div>
            <div>
              <Label>Termination email body</Label>
              <Textarea name="gpuKillEmailBody" rows={8} defaultValue={s.gpuKillEmailBody} className="font-mono text-xs" />
            </div>
            <div>
              <Label>Available variables</Label>
              <ul className="m-0 list-disc pl-5 text-xs text-muted-foreground">
                {GPU_EMAIL_VARS.map((v) => (
                  <li key={v.key}>
                    <code>{`{${v.key}}`}</code> — {v.desc}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Button type="submit">Save GPU emails</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Alerts &amp; logs</h3>
          <form action={saveAlertSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="alertsEnabled" defaultChecked={s.alertsEnabled} className="accent-primary" />
              Email admins on alerts
            </label>
            <div>
              <Label>Alert at log level</Label>
              <Select name="alertLevel" defaultValue={s.alertLevel}>
                <option value="WARN">WARN and above</option>
                <option value="ERROR">ERROR only</option>
              </Select>
            </div>
            <div>
              <Label>Dedup window (minutes)</Label>
              <Input name="alertDedupMinutes" type="number" defaultValue={s.alertDedupMinutes} />
            </div>
            <div>
              <Label>Quota alert at (%)</Label>
              <Input name="quotaAlertPct" type="number" defaultValue={s.quotaAlertPct} />
            </div>
            <div>
              <Label>Node offline grace (seconds)</Label>
              <Input name="nodeOfflineGraceSeconds" type="number" min={0} defaultValue={s.nodeOfflineGraceSeconds} />
            </div>
            <div>
              <Label>Log retention (days)</Label>
              <Input name="logRetentionDays" type="number" defaultValue={s.logRetentionDays} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save alerts</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">ZFS scrub</h3>
          {scrub && <p className="text-sm text-primary">{scrub}</p>}
          <p className="text-xs text-muted-foreground">
            Scrubs run on ZFS-capable nodes. Cold storage on an SMB mount is the share owner&apos;s
            responsibility and is never scrubbed. Errors found during a scrub raise an admin alert.
          </p>
          <form action={saveScrubSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="scrubEnabled" defaultChecked={s.scrubEnabled} className="accent-primary" />
              Enable scheduled scrubs
            </label>
            <div>
              <Label>Scrub every (days)</Label>
              <Input name="scrubIntervalDays" type="number" defaultValue={s.scrubIntervalDays} />
            </div>
            <div>
              <Label>Start at hour (0–23)</Label>
              <Input name="scrubHour" type="number" min={0} max={23} defaultValue={s.scrubHour} />
            </div>
            <div>
              <Label>Timezone</Label>
              <Input name="scrubTimezone" defaultValue={s.scrubTimezone} list="scrub-tz-list" placeholder="UTC" />
              <datalist id="scrub-tz-list">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save scrub</Button>
            </div>
          </form>
          <form action={scrubNowAction}>
            <Button type="submit" variant="secondary">
              Scrub now
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">WebDAV backup</h3>
          {backup && <p className="text-sm text-primary">{backup}</p>}
          <form action={saveWebdavSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>WebDAV base URL</Label>
              <Input name="webdavUrl" defaultValue={s.webdavUrl} placeholder="https://dav.example.com/labmgr" />
            </div>
            <div>
              <Label>Username</Label>
              <Input name="webdavUser" defaultValue={s.webdavUser} />
            </div>
            <div>
              <Label>Password</Label>
              <Input name="webdavPass" type="password" placeholder={s.webdavPass ? "•••••• (unchanged)" : ""} />
            </div>
            <div>
              <Label>Keep last N backups</Label>
              <Input name="webdavRetention" type="number" defaultValue={s.webdavRetention} />
            </div>
            <div>
              <Label>Backup every (hours, 0=off)</Label>
              <Input name="backupIntervalHours" type="number" defaultValue={s.backupIntervalHours} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save WebDAV</Button>
            </div>
          </form>
          <form action={backupNowAction}>
            <Button type="submit" variant="secondary">
              Back up now
            </Button>
          </form>
          {backups.length > 0 && (
            <div className="space-y-2 pt-2">
              <h4 className="text-sm font-semibold">Restore</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Backup</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map((b) => (
                    <TableRow key={b}>
                      <TableCell>{b}</TableCell>
                      <TableCell className="text-right">
                        <form action={restoreAction}>
                          <input type="hidden" name="name" value={b} />
                          <Button type="submit" variant="secondary" size="sm">
                            Stage restore
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">
                Staging a restore takes effect after the controller restarts.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

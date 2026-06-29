import Link from "next/link";
import { getSettings, TIB } from "@/lib/settings";
import { db } from "@/lib/db";
import { fmtBytes } from "@/lib/format";
import { logsContentBytes } from "@/lib/maintenance";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ConfirmButton } from "../_components/ConfirmButton";
import {
  clearLogsAction,
  saveAlertSettingsAction,
  saveGpuPolicyAction,
  saveScrubSettingsAction,
  saveSmtpSettingsAction,
  saveStorageSettingsAction,
  saveUsageScanSettingsAction,
  scrubNowAction,
  testEmailAction,
} from "./actions";

// A short list of common IANA timezones for the schedule pickers (free text still allowed).
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
  searchParams: Promise<{ smtp?: string; scrub?: string; logs?: string }>;
}) {
  const { smtp, scrub, logs: logsMsg } = await searchParams;
  const s = getSettings();
  const logCount = (db().prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n;
  const logBytes = logsContentBytes();
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
            <div className="sm:col-span-2">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Per-student usage scan</h3>
          <p className="text-xs text-muted-foreground">
            Once a night (by default at midnight) the controller measures each student&apos;s home /
            scratch / cold usage (a <em>du</em> scan) on every online lab&apos;s node, shown on the
            Stats page. Lab-level usage (image + fast/cold) is separate: the agent recomputes it on
            its own ~5-minute cadence.
          </p>
          <form action={saveUsageScanSettingsAction} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="usageScanEnabled" defaultChecked={s.usageScanEnabled} className="accent-primary" />
              Run the nightly per-student usage scan automatically
            </label>
            <div>
              <Label>Start at hour (0–23)</Label>
              <Input name="usageScanHour" type="number" min={0} max={23} defaultValue={s.usageScanHour} />
            </div>
            <div>
              <Label>Timezone</Label>
              <Input name="usageScanTimezone" defaultValue={s.usageScanTimezone} list="usage-tz-list" placeholder="UTC" />
              <datalist id="usage-tz-list">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save usage scan</Button>
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
          <p className="text-xs text-muted-foreground">
            The wording of every email the controller sends — welcome, GPU notifications, removal,
            quota alerts, the test email, and announcement starting points — is edited under{" "}
            <Link href="/email-templates" className="text-primary hover:underline">
              Templates
            </Link>
            .
          </p>
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
              <Input name="logRetentionDays" type="number" min={0} defaultValue={s.logRetentionDays} />
            </div>
            <div>
              <Label>Max log entries (0 = unlimited)</Label>
              <Input name="logMaxEntries" type="number" min={0} defaultValue={s.logMaxEntries} />
            </div>
            <div>
              <Label>Max log size (MB, 0 = unlimited)</Label>
              <Input name="logMaxSizeMb" type="number" min={0} step="any" defaultValue={s.logMaxSizeMb} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save alerts</Button>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">
              {logCount.toLocaleString()} log {logCount === 1 ? "entry" : "entries"} · ~{fmtBytes(logBytes)} stored.
              Rotation keeps the newest within every cap above.
            </span>
            <form action={clearLogsAction}>
              <ConfirmButton
                variant="destructive"
                size="sm"
                title="Delete all logs"
                confirm={`Permanently delete all ${logCount.toLocaleString()} log entries? This cannot be undone.`}
              >
                Delete all logs
              </ConfirmButton>
            </form>
          </div>
          {logsMsg && <p className="text-sm text-primary">{logsMsg}</p>}
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
    </div>
  );
}

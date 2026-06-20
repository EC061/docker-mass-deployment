import { listBackups } from "@/lib/backup";
import { getSettings, isWebdavConfigured, TIB } from "@/lib/settings";
import {
  backupNowAction,
  restoreAction,
  saveAlertSettingsAction,
  saveGpuPolicyAction,
  saveScrubSettingsAction,
  saveSmtpSettingsAction,
  saveStorageSettingsAction,
  saveWebdavSettingsAction,
  scrubNowAction,
  testEmailAction,
} from "./actions";

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
    <>
      <h2>Settings</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Storage & ports</h3>
        <form action={saveStorageSettingsAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div>
            <label>Default fast quota (TB)</label>
            <input name="fastTb" type="number" step="0.5" defaultValue={s.fastQuotaDefaultBytes / TIB} />
          </div>
          <div>
            <label>Default slow quota (TB)</label>
            <input name="slowTb" type="number" step="0.5" defaultValue={s.slowQuotaDefaultBytes / TIB} />
          </div>
          <div>
            <label>SSH port range start</label>
            <input name="sshPortStart" type="number" defaultValue={s.sshPortStart} />
          </div>
          <div>
            <label>SSH port range end</label>
            <input name="sshPortEnd" type="number" defaultValue={s.sshPortEnd} />
          </div>
          <div>
            <label>Old-file threshold (days)</label>
            <input name="oldFileThresholdDays" type="number" defaultValue={s.oldFileThresholdDays} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 140 }}>
              Save
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Email (external SMTP)</h3>
        {smtp && <p style={{ color: "var(--accent)" }}>{smtp}</p>}
        <form action={saveSmtpSettingsAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div>
            <label>SMTP host</label>
            <input name="smtpHost" defaultValue={s.smtpHost} placeholder="smtp.uga.edu" />
          </div>
          <div>
            <label>Port</label>
            <input name="smtpPort" type="number" defaultValue={s.smtpPort} />
          </div>
          <div>
            <label>Username</label>
            <input name="smtpUser" defaultValue={s.smtpUser} />
          </div>
          <div>
            <label>Password</label>
            <input name="smtpPass" type="password" placeholder={s.smtpPass ? "•••••• (unchanged)" : ""} />
          </div>
          <div>
            <label>From address</label>
            <input name="smtpFrom" defaultValue={s.smtpFrom} placeholder="labs@uga.edu" />
          </div>
          <div>
            <label>SSH host override (optional)</label>
            <input name="sshHostOverride" defaultValue={s.sshHostOverride} placeholder="gpu.uga.edu" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="smtpSecure" defaultChecked={s.smtpSecure} style={{ width: "auto" }} />
            <label style={{ margin: 0 }}>Implicit TLS (port 465)</label>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 140 }}>
              Save SMTP
            </button>
          </div>
        </form>
        <form action={testEmailAction} style={{ display: "flex", gap: 10, alignItems: "end", marginTop: 12 }}>
          <div>
            <label>Send test email to</label>
            <input name="to" type="email" placeholder="you@uga.edu" />
          </div>
          <button type="submit" style={{ width: 140, marginTop: 0, background: "var(--panel-2)" }}>
            Send test
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>GPU idle policy</h3>
        <form action={saveGpuPolicyAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="gpuEnabled" defaultChecked={s.gpuEnabled} style={{ width: "auto" }} />
            <label style={{ margin: 0 }}>Enable idle killer</label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="gpuImmediate" defaultChecked={s.gpuImmediate} style={{ width: "auto" }} />
            <label style={{ margin: 0 }}>Kill immediately (no grace)</label>
          </div>
          <div>
            <label>Idle util threshold (%)</label>
            <input name="gpuUtilThreshold" type="number" defaultValue={s.gpuUtilThreshold} />
          </div>
          <div>
            <label>Idle minutes before warning</label>
            <input name="gpuIdleMinutes" type="number" defaultValue={s.gpuIdleMinutes} />
          </div>
          <div>
            <label>Grace minutes before kill</label>
            <input name="gpuGraceMinutes" type="number" defaultValue={s.gpuGraceMinutes} />
          </div>
          <div></div>
          <div>
            <label>Whitelist users (comma-sep)</label>
            <input name="gpuWhitelistUsers" defaultValue={s.gpuWhitelistUsers} placeholder="alice,bob" />
          </div>
          <div>
            <label>Whitelist labs (comma-sep)</label>
            <input name="gpuWhitelistLabs" defaultValue={s.gpuWhitelistLabs} placeholder="bio,chem" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 200 }}>
              Save & push to nodes
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Alerts & logs</h3>
        <form action={saveAlertSettingsAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="alertsEnabled" defaultChecked={s.alertsEnabled} style={{ width: "auto" }} />
            <label style={{ margin: 0 }}>Email admins on alerts</label>
          </div>
          <div>
            <label>Alert at log level</label>
            <select name="alertLevel" defaultValue={s.alertLevel}>
              <option value="WARN">WARN and above</option>
              <option value="ERROR">ERROR only</option>
            </select>
          </div>
          <div>
            <label>Dedup window (minutes)</label>
            <input name="alertDedupMinutes" type="number" defaultValue={s.alertDedupMinutes} />
          </div>
          <div>
            <label>Quota alert at (%)</label>
            <input name="quotaAlertPct" type="number" defaultValue={s.quotaAlertPct} />
          </div>
          <div>
            <label>Log retention (days)</label>
            <input name="logRetentionDays" type="number" defaultValue={s.logRetentionDays} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 140 }}>
              Save alerts
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>ZFS scrub</h3>
        {scrub && <p style={{ color: "var(--accent)" }}>{scrub}</p>}
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Scrubs run on ZFS-capable nodes. Cold storage on an SMB mount is the share owner&apos;s
          responsibility and is never scrubbed. Errors found during a scrub raise an admin alert.
        </p>
        <form action={saveScrubSettingsAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="scrubEnabled" defaultChecked={s.scrubEnabled} style={{ width: "auto" }} />
            <label style={{ margin: 0 }}>Enable scheduled scrubs</label>
          </div>
          <div>
            <label>Scrub every (days)</label>
            <input name="scrubIntervalDays" type="number" defaultValue={s.scrubIntervalDays} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 140 }}>
              Save scrub
            </button>
          </div>
        </form>
        <form action={scrubNowAction} style={{ marginTop: 12 }}>
          <button type="submit" style={{ width: 140, marginTop: 0, background: "var(--panel-2)" }}>
            Scrub now
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>WebDAV backup</h3>
        {backup && <p style={{ color: "var(--accent)" }}>{backup}</p>}
        <form action={saveWebdavSettingsAction} style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label>WebDAV base URL</label>
            <input name="webdavUrl" defaultValue={s.webdavUrl} placeholder="https://dav.example.com/labmgr" />
          </div>
          <div>
            <label>Username</label>
            <input name="webdavUser" defaultValue={s.webdavUser} />
          </div>
          <div>
            <label>Password</label>
            <input name="webdavPass" type="password" placeholder={s.webdavPass ? "•••••• (unchanged)" : ""} />
          </div>
          <div>
            <label>Keep last N backups</label>
            <input name="webdavRetention" type="number" defaultValue={s.webdavRetention} />
          </div>
          <div>
            <label>Backup every (hours, 0=off)</label>
            <input name="backupIntervalHours" type="number" defaultValue={s.backupIntervalHours} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={{ width: 140 }}>
              Save WebDAV
            </button>
          </div>
        </form>
        <form action={backupNowAction} style={{ marginTop: 12 }}>
          <button type="submit" style={{ width: 140, marginTop: 0, background: "var(--panel-2)" }}>
            Back up now
          </button>
        </form>
        {backups.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h4 style={{ margin: "0 0 6px" }}>Restore</h4>
            <table>
              <thead>
                <tr>
                  <th>Backup</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b}>
                    <td>{b}</td>
                    <td style={{ textAlign: "right" }}>
                      <form action={restoreAction}>
                        <input type="hidden" name="name" value={b} />
                        <button type="submit" style={{ width: "auto", marginTop: 0, padding: "6px 10px", background: "var(--panel-2)" }}>
                          Stage restore
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12 }}>
              Staging a restore takes effect after the controller restarts.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

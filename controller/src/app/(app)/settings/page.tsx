import { getSettings, TIB } from "@/lib/settings";
import { saveStorageSettingsAction } from "./actions";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const s = getSettings();
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
        <p className="muted">
          External SMTP, WebDAV backup, GPU idle policy, and the log-level alert threshold are added in
          later phases.
        </p>
      </div>
    </>
  );
}

export default function SettingsPage() {
  return (
    <>
      <h2>Settings</h2>
      <div className="card">
        <p className="muted">
          External SMTP, WebDAV backup, GPU policy defaults, quota defaults (2 TB fast / 3 TB slow),
          SSH port range, and the log-level alert threshold are configured here — landing in phases 2–6.
        </p>
      </div>
    </>
  );
}

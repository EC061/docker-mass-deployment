import { audienceCounts, recentAnnouncements } from "@/lib/announcements";
import { isSmtpConfigured } from "@/lib/settings";
import { ago } from "@/lib/format";
import { sendAnnouncementAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const msg = typeof sp.msg === "string" ? sp.msg : undefined;
  const counts = audienceCounts();
  const history = recentAnnouncements();
  const smtpOk = isSmtpConfigured();

  return (
    <>
      <h2>Announcements</h2>

      {msg && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted">{msg}</p>
        </div>
      )}

      {!smtpOk && (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 16 }}>
          <p style={{ color: "var(--warn)" }}>
            SMTP is not configured, so announcements cannot be delivered. Set it up under{" "}
            <a href="/settings">Settings → Email</a> first.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Send a service announcement</h3>
        <form action={sendAnnouncementAction}>
          <label>
            Subject
            <input name="subject" required maxLength={200} placeholder="e.g. Scheduled maintenance Saturday" />
          </label>
          <label>
            Message
            <textarea name="body" required rows={6} placeholder="Write your announcement…" />
          </label>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, margin: "12px 0" }}>
            <legend className="muted" style={{ fontSize: 12 }}>Recipients</legend>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 20 }}>
              <input type="checkbox" name="students" defaultChecked style={{ width: "auto" }} />
              All users ({counts.students})
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" name="pis" style={{ width: "auto" }} />
              All PIs ({counts.pis})
            </label>
          </fieldset>
          <button type="submit" style={{ width: "auto" }}>Send announcement</button>
        </form>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Sent by email to the distinct addresses in the selected audiences. A PI who is also a user is
          mailed once.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent announcements</h3>
        {history.length === 0 ? (
          <p className="muted">Nothing sent yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td className="muted">{ago(a.ts)}</td>
                    <td>{a.actor ?? "—"}</td>
                    <td>{a.audiences.replace("students", "users").replace(/,/g, ", ")}</td>
                    <td>{a.subject}</td>
                    <td>
                      {a.skipped ? (
                        <span style={{ color: "var(--warn)" }}>skipped (no SMTP)</span>
                      ) : (
                        `${a.sent}/${a.recipients}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

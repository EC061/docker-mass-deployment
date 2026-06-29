import { ANNOUNCEMENT_VARS, audienceCounts, listAnnouncementTemplates, recentAnnouncements } from "@/lib/announcements";
import { isSmtpConfigured } from "@/lib/settings";
import { ago } from "@/lib/format";
import { sendAnnouncementAction } from "./actions";
import { AnnouncementComposer } from "./_components/AnnouncementComposer";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
  const templates = listAnnouncementTemplates();
  const smtpOk = isSmtpConfigured();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Announcements</h1>

      {msg && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">{msg}</p>
          </CardContent>
        </Card>
      )}

      {!smtpOk && (
        <Card className="border-warn/50">
          <CardContent>
            <p className="text-sm text-warn">
              SMTP is not configured, so announcements cannot be delivered. Set it up under{" "}
              <a href="/settings" className="underline">
                Settings → Email
              </a>{" "}
              first.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Send a service announcement</h3>
          <AnnouncementComposer
            templates={templates}
            vars={ANNOUNCEMENT_VARS}
            counts={counts}
            action={sendAnnouncementAction}
          />
          <p className="text-xs text-muted-foreground">
            Sent by email to the distinct addresses in the selected audiences (a PI who is also a user
            is mailed once). <code>{"{name}"}</code> and <code>{"{email}"}</code> are filled in per
            recipient. Manage the prebuilt templates and see every email variable under{" "}
            <a href="/email-templates" className="underline">Email templates</a>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Recent announcements</h3>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Delivered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{ago(a.ts)}</TableCell>
                    <TableCell>{a.actor ?? "—"}</TableCell>
                    <TableCell>{a.audiences.replace("students", "users").replace(/,/g, ", ")}</TableCell>
                    <TableCell>{a.subject}</TableCell>
                    <TableCell>
                      {a.skipped ? (
                        <span className="text-warn">skipped (no SMTP)</span>
                      ) : (
                        `${a.sent}/${a.recipients}`
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

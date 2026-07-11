import {
  ANNOUNCEMENT_VARS,
  audienceCounts,
  listAnnouncementPeople,
  listAnnouncementTemplates,
  recentAnnouncements,
} from "@/lib/announcements";
import { isSmtpConfigured } from "@/lib/settings";
import { ago } from "@/lib/format";
import { clearAnnouncementsAction, deleteAnnouncementAction, sendAnnouncementAction } from "./actions";
import { AnnouncementComposer } from "./_components/AnnouncementComposer";
import { ConfirmButton } from "../_components/ConfirmButton";
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
  const people = listAnnouncementPeople();
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
          <h2 className="text-base font-semibold">Send a service announcement</h2>
          <AnnouncementComposer
            templates={templates}
            vars={ANNOUNCEMENT_VARS}
            counts={counts}
            people={people}
            action={sendAnnouncementAction}
          />
          <p className="text-xs text-muted-foreground">
            Sent by email to the distinct addresses in the selected audiences and individually selected recipients
            (each address is mailed once). ALL-CAPS <code>[BRACKET]</code> spans in the subject or
            message become input fields above. <code>{"{name}"}</code> and <code>{"{email}"}</code>{" "}
            are filled in per recipient. Manage the prebuilt templates and see every email variable
            under <a href="/email-templates" className="underline">Email templates</a>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Recent announcements</h2>
            {history.length > 0 && (
              <form action={clearAnnouncementsAction}>
                <ConfirmButton
                  size="sm"
                  title="Clear announcement history?"
                  confirmLabel="Clear all"
                  confirm="Delete all recorded announcements? This cannot be undone."
                >
                  Clear all
                </ConfirmButton>
              </form>
            )}
          </div>
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
                  <TableHead />
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
                    <TableCell className="text-right">
                      <form action={deleteAnnouncementAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          title="Delete announcement?"
                          confirmLabel="Delete"
                          confirm={`Delete the recorded announcement "${a.subject}"? This cannot be undone.`}
                        >
                          Delete
                        </ConfirmButton>
                      </form>
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

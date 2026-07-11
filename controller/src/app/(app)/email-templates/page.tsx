import Link from "next/link";
import { ANNOUNCEMENT_VARS, listAnnouncementTemplates, type AnnouncementTemplate } from "@/lib/announcements";
import {
  GPU_EMAIL_VARS,
  QUOTA_EMAIL_VARS,
  PLACEMENT_COMPLETE_EMAIL_VARS,
  REMOVAL_EMAIL_VARS,
  USAGE_REPORT_EMAIL_VARS,
  WELCOME_EMAIL_VARS,
  STUDENT_QUOTA_EMAIL_VARS,
  getSettings,
} from "@/lib/settings";
import { takeFlash } from "@/lib/flash";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton } from "../_components/ConfirmButton";
import { SignatureEditor } from "./_components/SignatureEditor";
import {
  createAnnouncementTemplateAction,
  deleteAnnouncementTemplateAction,
  saveGpuKillEmailAction,
  saveGpuWarnEmailAction,
  saveQuotaEmailAction,
  saveStudentQuotaEmailAction,
  savePlacementCompleteEmailAction,
  saveRemovalEmailAction,
  saveTestEmailAction,
  saveUniversalSignatureAction,
  saveUsageReportPiEmailAction,
  saveUsageReportStudentEmailAction,
  saveWelcomeEmailAction,
  updateAnnouncementTemplateAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface Variable {
  key: string;
  desc: string;
}

function VarList({ vars }: { vars: Variable[] }) {
  if (vars.length === 0) {
    return <p className="text-sm text-muted-foreground">No variables — this message is fixed text.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {vars.map((v) => (
        <li key={v.key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{`{${v.key}}`}</code>
          <span className="text-muted-foreground">{v.desc}</span>
        </li>
      ))}
    </ul>
  );
}

interface EditableTemplateProps {
  name: string;
  trigger: string;
  /** Server action the subject/body form submits to. */
  action: (formData: FormData) => void | Promise<void>;
  subject: string;
  body: string;
  vars: Variable[];
  bodyRows?: number;
  note?: string;
}

/** A card with an inline form to edit one email's subject + body, plus its variable reference. */
function EditableTemplate({ name, trigger, action, subject, body, vars, bodyRows = 10, note }: EditableTemplateProps) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{name}</h2>
          <p className="text-sm text-muted-foreground">{trigger}</p>
        </div>
        <form action={action} className="grid gap-3">
          <div>
            <Label>Subject</Label>
            <Input name="subject" defaultValue={subject} />
          </div>
          <div>
            <Label>Body</Label>
            <Textarea name="body" rows={bodyRows} defaultValue={body} className="font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Available variables
            </div>
            <VarList vars={vars} />
          </div>
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          <div>
            <Button type="submit">Save template</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** One editable prebuilt announcement template (name + subject + body), with a delete control. */
function AnnouncementTemplateCard({ tpl }: { tpl: AnnouncementTemplate }) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <form action={updateAnnouncementTemplateAction} className="grid gap-3">
        <input type="hidden" name="id" value={tpl.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Template name</Label>
            <Input name="name" defaultValue={tpl.name} maxLength={80} required />
          </div>
          <div>
            <Label>Subject</Label>
            <Input name="subject" defaultValue={tpl.subject} maxLength={200} />
          </div>
        </div>
        <div>
          <Label>Body</Label>
          <Textarea name="body" rows={8} defaultValue={tpl.body} required className="font-mono text-xs" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm">Save</Button>
        </div>
      </form>
      <form action={deleteAnnouncementTemplateAction}>
        <input type="hidden" name="id" value={tpl.id} />
        <ConfirmButton
          size="sm"
          variant="ghost"
          title={`Delete template "${tpl.name}"?`}
          confirmLabel="Delete template"
          confirm={`Delete the announcement template "${tpl.name}"? This only removes the prebuilt starting point; it does not affect any announcement already sent.`}
        >
          Delete
        </ConfirmButton>
      </form>
    </div>
  );
}

export default async function EmailTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const errorMsg = error ? takeFlash(error) : null;
  const savedMsg = saved ? takeFlash(saved) : null;
  const s = getSettings();
  const gpuKillVars = GPU_EMAIL_VARS.filter((v) => v.key !== "grace_minutes");
  const announcementTemplates = listAnnouncementTemplates();

  return (
    <div className="max-w-3xl space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Email templates</h1>
        <p className="text-sm text-muted-foreground">
          Every email the controller sends is edited here. Use the <code>{"{variables}"}</code> listed
          under each one; an unknown <code>{"{token}"}</code> is left in the text as-is so typos are
          visible, and a blank subject falls back to the built-in default. All email delivery requires
          SMTP to be configured under{" "}
          <Link href="/settings" className="text-primary hover:underline">
            Settings → Email
          </Link>
          .
        </p>
      </div>

      <SignatureEditor text={s.emailSignatureText} action={saveUniversalSignatureAction} />

      <EditableTemplate
        name="Welcome / credentials"
        trigger="Sent to a student or PI only after the node agent proves the initial credential with a real SSH login."
        action={saveWelcomeEmailAction}
        subject={s.welcomeEmailSubject}
        body={s.welcomeEmailBody}
        vars={WELCOME_EMAIL_VARS}
        bodyRows={16}
      />

      <EditableTemplate
        name="Node setup complete — PI"
        trigger="Sent once to the PI after the placement container is running and every student and PI login has passed SSH verification."
        action={savePlacementCompleteEmailAction}
        subject={s.placementCompleteEmailSubject}
        body={s.placementCompleteEmailBody}
        vars={PLACEMENT_COMPLETE_EMAIL_VARS}
        bodyRows={15}
      />

      <EditableTemplate
        name="GPU idle warning"
        trigger="Sent to a user whose process is holding GPU memory while idle, before it is terminated."
        action={saveGpuWarnEmailAction}
        subject={s.gpuWarnEmailSubject}
        body={s.gpuWarnEmailBody}
        vars={GPU_EMAIL_VARS}
        bodyRows={8}
      />

      <EditableTemplate
        name="GPU process terminated"
        trigger="Sent to a user after their idle GPU process has been terminated to free the GPU."
        action={saveGpuKillEmailAction}
        subject={s.gpuKillEmailSubject}
        body={s.gpuKillEmailBody}
        vars={gpuKillVars}
        bodyRows={8}
      />

      <EditableTemplate
        name="Removed from lab"
        trigger="Sent to a student when they are removed from a lab. {data_status} resolves to a sentence noting whether their data was deleted or retained."
        action={saveRemovalEmailAction}
        subject={s.removalEmailSubject}
        body={s.removalEmailBody}
        vars={REMOVAL_EMAIL_VARS}
        bodyRows={6}
      />

      <EditableTemplate
        name="Storage quota alert"
        trigger="Sent to a lab's PI when one of its pools crosses the quota-alert threshold (Settings → Alerts)."
        action={saveQuotaEmailAction}
        subject={s.quotaEmailSubject}
        body={s.quotaEmailBody}
        vars={QUOTA_EMAIL_VARS}
        bodyRows={12}
      />

      <EditableTemplate
        name="Per-user quota warning"
        trigger="Sent automatically when a user crosses the configured percentage of their assigned per-user quota; Settings can also copy admins."
        action={saveStudentQuotaEmailAction}
        subject={s.studentQuotaEmailSubject}
        body={s.studentQuotaEmailBody}
        vars={STUDENT_QUOTA_EMAIL_VARS}
        bodyRows={10}
      />

      <EditableTemplate
        name="Storage usage report — student"
        trigger="Sent to one student when an admin emails a storage-usage report from the Stats page. Their row in the table is marked “(you)”."
        action={saveUsageReportStudentEmailAction}
        subject={s.usageReportStudentSubject}
        body={s.usageReportStudentBody}
        vars={USAGE_REPORT_EMAIL_VARS}
        bodyRows={16}
      />

      <EditableTemplate
        name="Storage usage report — PI"
        trigger="Sent to a lab's PI when an admin emails a whole-roster storage-usage report from the Stats page."
        action={saveUsageReportPiEmailAction}
        subject={s.usageReportPiSubject}
        body={s.usageReportPiBody}
        vars={USAGE_REPORT_EMAIL_VARS}
        bodyRows={14}
      />

      <EditableTemplate
        name="Test email"
        trigger="Sent when an admin clicks “Send test” under Settings → Email to verify SMTP."
        action={saveTestEmailAction}
        subject={s.testEmailSubject}
        body={s.testEmailBody}
        vars={[]}
        bodyRows={4}
      />

      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Announcement templates</h2>
            <p className="text-sm text-muted-foreground">
              Prebuilt starting points offered in the{" "}
              <Link href="/announcements" className="text-primary hover:underline">
                Announcements
              </Link>{" "}
              compose form. Picking one fills the subject/body, which the admin edits before sending. A
              plain-text signature above is appended to every announcement on send.
            </p>
            <div className="space-y-1.5 pt-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Variables (substituted on send)
              </div>
              <VarList vars={ANNOUNCEMENT_VARS} />
              <p className="text-xs text-muted-foreground">
                ALL-CAPS spans in <code>[BRACKETS]</code> become input fields on the compose form for
                the admin to fill in before sending.
              </p>
            </div>
          </div>

          {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
          {savedMsg && <p className="text-sm text-primary">{savedMsg}</p>}

          {announcementTemplates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates yet — add one below.</p>
          ) : (
            announcementTemplates.map((tpl) => <AnnouncementTemplateCard key={tpl.id} tpl={tpl} />)
          )}

          <form action={createAnnouncementTemplateAction} className="grid gap-3 border-t border-border pt-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Add a template
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Template name</Label>
                <Input name="name" placeholder="e.g. Holiday closure" maxLength={80} required />
              </div>
              <div>
                <Label>Subject</Label>
                <Input name="subject" placeholder="e.g. Cluster closed [DATE]–[DATE]" maxLength={200} />
              </div>
            </div>
            <div>
              <Label>Body</Label>
              <Textarea name="body" rows={6} required className="font-mono text-xs" placeholder="Hello {name}, …" />
            </div>
            <div>
              <Button type="submit" size="sm">Add template</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

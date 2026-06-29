import Link from "next/link";
import {
  ANNOUNCEMENT_TEMPLATES,
  ANNOUNCEMENT_VARS,
} from "@/lib/announcements";
import {
  GPU_EMAIL_VARS,
  WELCOME_EMAIL_VARS,
  getSettings,
} from "@/lib/settings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

interface Variable {
  key: string;
  desc: string;
}

interface TemplateDoc {
  name: string;
  trigger: string;
  /** Where the admin edits this template, or null if it is fixed in code. */
  editable: { href: string; label: string } | null;
  vars: Variable[];
  subject: string;
  body: string;
  note?: string;
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

function TemplateCard({ tpl }: { tpl: TemplateDoc }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{tpl.name}</h3>
          {tpl.editable ? (
            <Badge variant="ok">editable</Badge>
          ) : (
            <Badge variant="warn">fixed</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{tpl.trigger}</p>
        {tpl.editable && (
          <p className="text-sm">
            Edit at{" "}
            <Link href={tpl.editable.href} className="text-primary hover:underline">
              {tpl.editable.label}
            </Link>
            .
          </p>
        )}

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Available variables
          </div>
          <VarList vars={tpl.vars} />
        </div>

        <div className="space-y-2">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</div>
            <div className="mt-1 overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
              {tpl.subject}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Body</div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
              {tpl.body}
            </pre>
          </div>
        </div>

        {tpl.note && <p className="text-xs text-muted-foreground">{tpl.note}</p>}
      </CardContent>
    </Card>
  );
}

export default async function EmailTemplatesPage() {
  const s = getSettings();
  const gpuKillVars = GPU_EMAIL_VARS.filter((v) => v.key !== "grace_minutes");

  const templates: TemplateDoc[] = [
    {
      name: "Welcome / credentials",
      trigger: "Sent to a student once they are successfully provisioned on a node — carries their login and SSH connection details.",
      editable: { href: "/settings", label: "Settings → Email" },
      vars: WELCOME_EMAIL_VARS,
      subject: s.welcomeEmailSubject,
      body: s.welcomeEmailBody,
    },
    {
      name: "GPU idle warning",
      trigger: "Sent to a user whose process is holding GPU memory while idle, before it is terminated.",
      editable: { href: "/settings", label: "Settings → GPU policy" },
      vars: GPU_EMAIL_VARS,
      subject: s.gpuWarnEmailSubject,
      body: s.gpuWarnEmailBody,
    },
    {
      name: "GPU process terminated",
      trigger: "Sent to a user after their idle GPU process has been terminated to free the GPU.",
      editable: { href: "/settings", label: "Settings → GPU policy" },
      vars: gpuKillVars,
      subject: s.gpuKillEmailSubject,
      body: s.gpuKillEmailBody,
    },
    {
      name: "Service announcement",
      trigger: "Composed by an admin and broadcast to all students and/or all PIs.",
      editable: { href: "/announcements", label: "Announcements" },
      vars: ANNOUNCEMENT_VARS,
      subject: "(composed per send)",
      body: `(composed per send — ${ANNOUNCEMENT_TEMPLATES.length} prebuilt starting points are offered on the Announcements page)\n\nPrebuilt templates:\n${ANNOUNCEMENT_TEMPLATES.map((t) => `  • ${t.name}`).join("\n")}`,
      note: "A fixed “— Lab Manager” signature is appended to every announcement.",
    },
    {
      name: "Removed from lab",
      trigger: "Sent to a student when they are removed from a lab (notes whether their data was deleted).",
      editable: null,
      vars: [{ key: "lab", desc: "lab name (substituted into the fixed text)" }],
      subject: "Removed from lab {lab}",
      body: `You have been removed from the lab "{lab}". <your data was deleted | your data has been retained for now>.\n\n— Lab Manager`,
    },
    {
      name: "Storage quota alert",
      trigger: "Sent to a lab's PI when one of its pools crosses the quota-alert threshold (Settings → Alerts).",
      editable: null,
      vars: [
        { key: "lab", desc: "lab name" },
        { key: "pool", desc: "pool that crossed the threshold (fast/cold)" },
        { key: "pct", desc: "percent of quota used" },
        { key: "used / quota", desc: "human-readable used and total" },
      ],
      subject: "Lab {lab} is at {pct}% of its {pool} quota",
      body: `Lab "{lab}" has reached {pct}% of its {pool} storage quota ({used} of {quota}).\n\nPer-student usage on the {pool} pool:\n  <username>  <used>\n  …\n\n— Lab Manager`,
    },
    {
      name: "Test email",
      trigger: "Sent when an admin clicks “Send test” under Settings → Email to verify SMTP.",
      editable: null,
      vars: [],
      subject: "Lab Manager test email",
      body: "This is a test email from the Lab Manager controller. SMTP is configured correctly.",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Email templates</h1>
        <p className="text-sm text-muted-foreground">
          Every email the controller can send, with the <code>{"{variables}"}</code> each one
          understands. Editable templates fall back to the built-in default when left blank; an unknown{" "}
          <code>{"{token}"}</code> is left in the text as-is so typos are visible. All email requires SMTP
          configured under{" "}
          <Link href="/settings" className="text-primary hover:underline">
            Settings → Email
          </Link>
          .
        </p>
      </div>

      {templates.map((tpl) => (
        <TemplateCard key={tpl.name} tpl={tpl} />
      ))}
    </div>
  );
}

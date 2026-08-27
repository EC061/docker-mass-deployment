"use client";

import { useMemo, useRef, useState } from "react";
import type { AnnouncementTemplate, Person, RecipientGroup } from "@/lib/announcements";
import { renderAnnouncementPreview, type AnnouncementPreviewSender } from "@/lib/announcement-preview";
import { formatEmailFrom, type EmailFrom } from "@/lib/email";
import { extractBracketTokens } from "@/lib/template";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RecipientPicker } from "./RecipientPicker";

interface Props {
  templates: AnnouncementTemplate[];
  vars: { key: string; desc: string }[];
  people: Person[];
  groups: RecipientGroup[];
  sender: AnnouncementPreviewSender;
  /** The From recipients will see: the delivering SMTP config's address under the sender name. */
  from: EmailFrom;
  signatureText: string;
  action: (formData: FormData) => void | Promise<void>;
}

/**
 * Compose form for a service announcement. A prebuilt-template picker fills the subject/body fields,
 * and the variable chips insert {tokens} at the cursor — both are starting points the admin edits
 * before sending. ALL-CAPS [BRACKET] spans in the subject/body each get a required input below the
 * message; the values post as ph_<TOKEN> fields and the server fills them in. The fields stay
 * controlled so the picker/inserts and the user's typing agree; the form still submits straight to
 * the server action.
 */
export function AnnouncementComposer({ templates, vars, people, groups, sender, from, signatureText, action }: Props) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  // Placeholder values are keyed by token and kept even when a token temporarily disappears while
  // editing, so retyping [DATE] doesn't lose what was already entered.
  const [phValues, setPhValues] = useState<Record<string, string>>({});
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const tokens = useMemo(() => extractBracketTokens(subject + "\n" + body), [subject, body]);
  const peopleByEmail = useMemo(() => new Map(people.map((person) => [person.email, person])), [people]);
  const selectedPeople = useMemo(
    () => selectedEmails.map((email) => peopleByEmail.get(email)).filter((person): person is Person => !!person),
    [peopleByEmail, selectedEmails],
  );
  const preview = useMemo(
    () => renderAnnouncementPreview({
      subject,
      body,
      recipients: selectedPeople,
      sender,
      placeholders: phValues,
      signatureText,
    }),
    [body, phValues, selectedPeople, sender, signatureText, subject],
  );

  function applyTemplate(id: string) {
    const tpl = templates.find((t) => String(t.id) === id);
    if (!tpl) return;
    setSubject(tpl.subject);
    setBody(tpl.body);
  }

  /** Insert {key} at the cursor in the body textarea (or append if it isn't focused). */
  function insertVar(key: string) {
    const token = `{${key}}`;
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    // Restore focus and place the caret just after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    // Two columns on wide screens: the editable form on the left, the live preview pinned beside it
    // on the right so edits and their rendered result stay in view together. Stacks below xl.
    <form action={action} className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]">
      <div className="min-w-0 space-y-3">
        <div>
          <Label htmlFor="ann-template">Start from a template</Label>
          <select
            id="ann-template"
            defaultValue=""
            onChange={(e) => applyTemplate(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-72"
          >
            <option value="">— blank message —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label>Subject</Label>
          <Input
            name="subject"
            required
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Scheduled maintenance Saturday"
          />
        </div>

        <div>
          <Label>Message</Label>
          <Textarea
            ref={bodyRef}
            name="body"
            required
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your announcement…"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Insert variable:</span>
            {vars.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => insertVar(v.key)}
                title={v.desc}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-accent hover:text-accent-foreground"
              >
                {`{${v.key}}`}
              </button>
            ))}
          </div>
        </div>

        {tokens.length > 0 && (
          <fieldset className="rounded-md border border-border p-3">
            <legend className="px-1 text-xs text-muted-foreground">Fill in placeholders</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {tokens.map((token) => (
                <div key={token}>
                  <Label htmlFor={`ph-${token}`} className="font-mono text-xs">{`[${token}]`}</Label>
                  <Input
                    id={`ph-${token}`}
                    name={`ph_${token}`}
                    required
                    value={phValues[token] ?? ""}
                    onChange={(e) => setPhValues((v) => ({ ...v, [token]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Recipients</legend>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              The shortcuts tick everyone in that group below — untick anyone you want to leave out.
              Each address is mailed once however many groups it falls in.
            </p>
            <RecipientPicker
              people={people}
              groups={groups}
              selectedEmails={selectedEmails}
              onSelectedEmailsChange={setSelectedEmails}
            />
          </div>
        </fieldset>

        <Button type="submit">Send announcement</Button>
      </div>

      <section
        className="min-w-0 overflow-hidden rounded-md border border-border bg-muted/20 xl:sticky xl:top-6"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h3 className="text-sm font-semibold">Live email preview</h3>
          <span className="text-xs text-muted-foreground">
            {preview.recipient
              ? `First selected recipient: ${preview.recipient.name}`
              : "Select a recipient to preview recipient variables"}
          </span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs">
          <dt className="text-muted-foreground">From</dt>
          {/* Exactly what the mailer will put on the wire: the SMTP provider's own address, under
              the configured sender name. The {sender_email} the body quotes is a contact address
              and deliberately independent of this. */}
          <dd className="min-w-0 truncate">
            {from.address ? formatEmailFrom(from) : "(no SMTP sender configured)"}
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0 truncate">
            {preview.recipient
              ? `${preview.recipient.name} <${preview.recipient.email}>`
              : "{name} <{email}>"}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="min-w-0 break-words font-medium">{preview.subject || "(No subject yet)"}</dd>
        </dl>
        <pre className="min-h-40 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm">
          {preview.body || "Write a message to preview it here."}
        </pre>
      </section>
    </form>
  );
}

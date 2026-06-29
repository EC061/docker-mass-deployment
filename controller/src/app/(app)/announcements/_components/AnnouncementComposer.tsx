"use client";

import { useRef, useState } from "react";
import type { AnnouncementTemplate } from "@/lib/announcements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  templates: AnnouncementTemplate[];
  vars: { key: string; desc: string }[];
  counts: { students: number; pis: number };
  action: (formData: FormData) => void | Promise<void>;
}

/**
 * Compose form for a service announcement. A prebuilt-template picker fills the subject/body fields,
 * and the variable chips insert {tokens} at the cursor — both are starting points the admin edits
 * before sending. The fields stay controlled so the picker/inserts and the user's typing agree; the
 * form still submits straight to the server action.
 */
export function AnnouncementComposer({ templates, vars, counts, action }: Props) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function applyTemplate(name: string) {
    const tpl = templates.find((t) => t.name === name);
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
    <form action={action} className="space-y-3">
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
            <option key={t.name} value={t.name}>
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

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs text-muted-foreground">Recipients</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="students" defaultChecked className="accent-primary" />
            All users ({counts.students})
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="pis" className="accent-primary" />
            All PIs ({counts.pis})
          </label>
        </div>
      </fieldset>

      <Button type="submit">Send announcement</Button>
    </form>
  );
}

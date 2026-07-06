"use client";

/**
 * A quiet, per-placement control that emails a storage-usage report ("please clean up your files")
 * to either the lab's PI or one roster student. It sits next to the per-student "Scan now" control,
 * so it stays visually secondary: a compact recipient <select> plus a send button, with the send
 * result surfaced inline. The server action is passed in so this stays decoupled from "use server"
 * imports (matching ImportStudentsForm).
 *
 * Recipients without an email on file are still listed but disabled, so the roster reads the same as
 * everywhere else while a report can only be sent to an address we actually have.
 */

import { useState, useTransition } from "react";
import { Loader2, Mail } from "lucide-react";
import type { EmailUsageReportResult } from "../actions";
import type { LabStats } from "@/lib/stats";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

interface Props {
  lab: LabStats;
  sendAction: (formData: FormData) => Promise<EmailUsageReportResult>;
}

function resultMessage(r: EmailUsageReportResult): { text: string; ok: boolean } {
  switch (r.status) {
    case "sent":
      return { text: `Report sent to ${r.to}`, ok: true };
    case "skipped":
      return { text: `SMTP not configured — nothing sent (would go to ${r.to})`, ok: false };
    case "missing_email":
      return { text: "That recipient has no email address on file", ok: false };
    case "unknown_recipient":
      return { text: "Recipient is no longer on this lab's roster", ok: false };
    case "unknown_placement":
      return { text: "This placement no longer exists", ok: false };
    case "send_failed":
      return { text: `Send failed: ${r.error}`, ok: false };
  }
}

export function EmailReportControl({ lab, sendAction }: Props) {
  const piHasEmail = !!lab.piEmail?.trim();
  const piLabel = `PI · ${lab.piName?.trim() || lab.piEmail || "no PI on file"}`;
  // Default to the first recipient we can actually email: the PI, else the first student with an email.
  const firstStudentWithEmail = lab.students.find((s) => s.email?.trim());
  const defaultRecipient = piHasEmail
    ? "pi"
    : firstStudentWithEmail
      ? String(firstStudentWithEmail.studentId)
      : "";

  const [recipient, setRecipient] = useState(defaultRecipient);
  const [result, setResult] = useState<EmailUsageReportResult | null>(null);
  const [pending, start] = useTransition();

  function onSend() {
    if (!recipient) return;
    setResult(null);
    start(async () => {
      const fd = new FormData();
      fd.set("placementId", String(lab.placementId));
      fd.set("recipient", recipient);
      setResult(await sendAction(fd));
    });
  }

  const msg = result ? resultMessage(result) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Select
        aria-label="Report recipient"
        value={recipient}
        onChange={(e) => {
          setRecipient(e.target.value);
          setResult(null);
        }}
        className="h-8 w-56 text-xs"
      >
        <option value="pi" disabled={!piHasEmail}>
          {piLabel}
          {piHasEmail ? "" : " (no email)"}
        </option>
        {lab.students.map((s) => {
          const hasEmail = !!s.email?.trim();
          return (
            <option key={s.studentId} value={String(s.studentId)} disabled={!hasEmail}>
              {s.username}
              {s.name ? ` · ${s.name}` : ""}
              {hasEmail ? "" : " (no email)"}
            </option>
          );
        })}
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onSend}
        disabled={pending || !recipient}
        aria-busy={pending}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Mail />}
        {pending ? "Sending…" : "Email report"}
      </Button>
      {msg && (
        <span className={msg.ok ? "text-primary" : "text-amber-500"} aria-live="polite">
          {msg.text}
        </span>
      )}
    </div>
  );
}

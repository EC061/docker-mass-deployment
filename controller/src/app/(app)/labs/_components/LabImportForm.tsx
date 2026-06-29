"use client";

import { useRef, useState, useTransition } from "react";
import type { ImportPlan, ImportResult } from "@/lib/labimport";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = `lab_name,pi_name,pi_email,student_id,username,student_name,student_email
smith-lab,Dr. Jane Smith,jane.smith@example.edu,100001,jdoe,John Doe,jdoe@example.edu
smith-lab,Dr. Jane Smith,jane.smith@example.edu,100002,asmith,Alice Smith,asmith@example.edu
empty-lab,Dr. Mary Lee,mary.lee@example.edu,,,,`;

interface Props {
  preview: (text: string) => Promise<ImportPlan>;
  apply: (text: string) => Promise<{ result?: ImportResult; error?: string }>;
}

function Summary({ plan }: { plan: ImportPlan }) {
  const rows: [string, number][] = [
    ["Labs to create", plan.labsToCreate.length],
    ["Labs to update", plan.labsToUpdate.length],
    ["Students to create", plan.studentsToCreate.length],
    ["Students to update", plan.studentsToUpdate.length],
    ["Memberships to add", plan.membershipsToAdd.length],
  ];
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {rows.map(([label, n]) => (
          <div key={label} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-semibold tabular-nums">{n}</span>
          </div>
        ))}
      </div>
      {plan.invalid.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5">
          <div className="font-medium text-destructive">Invalid rows ({plan.invalid.length})</div>
          <ul className="mt-1 list-inside list-disc text-xs text-destructive/90">
            {plan.invalid.slice(0, 20).map((c, i) => (
              <li key={i}>line {c.line}: {c.message}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.conflicts.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
          <div className="font-medium text-amber-600">Conflicts ({plan.conflicts.length})</div>
          <ul className="mt-1 list-inside list-disc text-xs text-amber-700 dark:text-amber-400">
            {plan.conflicts.slice(0, 20).map((c, i) => (
              <li key={i}>line {c.line}: {c.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function LabImportForm({ preview, apply }: Props) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function onPreview() {
    setErr(null);
    setDone(null);
    start(async () => {
      try {
        setPlan(await preview(text));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "preview failed");
      }
    });
  }

  function onApply() {
    setErr(null);
    start(async () => {
      const res = await apply(text);
      if (res.error) {
        setErr(res.error);
      } else if (res.result) {
        const r = res.result;
        setDone(
          `Imported: ${r.labsCreated} labs created, ${r.labsUpdated} updated; ${r.studentsCreated} students created, ${r.studentsUpdated} updated; ${r.membershipsAdded} memberships added` +
            (r.provisioned ? `; ${r.provisioned} queued on existing placements (credentials follow agent confirmation)` : ""),
        );
        setPlan(null);
        setText("");
      }
    });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Columns: <code>lab_name,pi_name,pi_email,student_id,username,student_name,student_email</code>.
        One row per membership; leave the student columns blank to create an empty lab. The whole file
        is validated before anything is written, and re-importing is idempotent.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={SAMPLE}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          Choose file…
        </Button>
        <Button type="button" onClick={onPreview} disabled={pending || !text.trim()}>
          {pending ? "Working…" : "Preview"}
        </Button>
        {plan && plan.ok && plan.membershipsToAdd.length + plan.labsToCreate.length + plan.labsToUpdate.length + plan.studentsToCreate.length + plan.studentsToUpdate.length > 0 && (
          <Button type="button" onClick={onApply} disabled={pending}>
            Apply import
          </Button>
        )}
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {done && <p className="text-sm text-primary">{done}</p>}
      {plan && (
        <div className="rounded-md border border-border/60 p-3">
          {!plan.ok && (
            <p className="mb-2 text-sm font-medium text-destructive">
              Not committable — fix the issues below and preview again.
            </p>
          )}
          {plan.ok && plan.labsToCreate.length + plan.labsToUpdate.length + plan.studentsToCreate.length + plan.studentsToUpdate.length + plan.membershipsToAdd.length === 0 && (
            <p className="mb-2 text-sm text-muted-foreground">Nothing to change — already up to date.</p>
          )}
          <Summary plan={plan} />
        </div>
      )}
    </div>
  );
}

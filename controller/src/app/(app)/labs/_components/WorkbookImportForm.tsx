"use client";

import { Fragment, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { parseXlsx } from "@/lib/xlsx";
import type {
  WorkbookImportPlan,
  WorkbookImportResult,
  WorkbookLabPlan,
  WorkbookPerson,
  WorkbookSheet,
} from "@/lib/workbookimport";
import { composeName } from "@/lib/names";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Props {
  preview: (sheets: WorkbookSheet[]) => Promise<WorkbookImportPlan>;
  apply: (sheets: WorkbookSheet[]) => Promise<{ result?: WorkbookImportResult; error?: string }>;
}

function summarize(result: WorkbookImportResult): string {
  const parts = [
    result.labsCreated.length > 0 ? `created ${result.labsCreated.join(", ")}` : null,
    result.labsUpdated.length > 0 ? `updated ${result.labsUpdated.join(", ")}` : null,
    `${result.studentsCreated} account${result.studentsCreated === 1 ? "" : "s"} created`,
    result.studentsUpdated > 0 ? `${result.studentsUpdated} updated` : null,
    `${result.membershipsAdded} roster addition${result.membershipsAdded === 1 ? "" : "s"}`,
    result.pisSet > 0 ? `${result.pisSet} PI${result.pisSet === 1 ? "" : "s"} designated` : null,
    result.provisioned > 0 ? `${result.provisioned} queued on existing nodes` : null,
  ].filter(Boolean);
  return `Imported: ${parts.join("; ")}.`;
}

/** What the import does to one person's global login, said in the roster's own words. */
const ACCOUNT_LABEL: Record<WorkbookPerson["action"], { text: string; variant: "ok" | "warn" | "secondary" }> = {
  create: { text: "new account", variant: "ok" },
  update: { text: "account updated", variant: "warn" },
  unchanged: { text: "account exists", variant: "secondary" },
};

/**
 * One lab's roster as the workbook lists it. An account is a login and a membership is a place on
 * this lab's roster — the two differ (someone with an account can still be joining), so each person
 * carries both, rather than leaving the reader to work it out from the counters.
 */
function LabRoster({ lab }: { lab: WorkbookLabPlan }) {
  const already = lab.people.length - lab.membersToAdd;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs">
      <p className="text-muted-foreground">
        Everyone on sheet <code>{lab.sheet}</code> — {lab.people.length} listed,{" "}
        {lab.membersToAdd === 0
          ? `all already on ${lab.lab}'s roster`
          : already === 0
            ? `all joining ${lab.lab}`
            : `${lab.membersToAdd} joining ${lab.lab}, ${already} already on its roster`}
        .
      </p>
      <ul className="divide-y divide-border/60">
        {lab.people.map((p) => {
          const account = ACCOUNT_LABEL[p.action];
          return (
            <li key={p.username} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
              <code className="text-foreground">{p.username}</code>
              <span>{composeName(p.firstName, p.lastName) ?? "—"}</span>
              <span className="text-muted-foreground">{p.email ?? "no email"}</span>
              {p.degree && <span className="text-muted-foreground">{p.degree}</span>}
              {p.isPi && <Badge variant="default">PI</Badge>}
              <span className="ml-auto flex items-center gap-1.5">
                <Badge variant={account.variant}>{account.text}</Badge>
                <Badge variant={p.alreadyMember ? "secondary" : "ok"}>
                  {p.alreadyMember ? "on roster" : "joining"}
                </Badge>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Upload the department roster workbook: one sheet per lab, parsed in the browser (the .xlsx itself
 * never leaves the machine) and previewed against the server before anything is created.
 */
export function WorkbookImportForm({ preview, apply }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<WorkbookSheet[]>([]);
  const [plan, setPlan] = useState<WorkbookImportPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** Sheet name of the lab whose roster is expanded, if any. */
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /** Drop the chosen workbook and its preview, leaving any success/error message on screen. */
  function clearWorkbook() {
    setSheets([]);
    setPlan(null);
    setOpenSheet(null);
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  }

  function reset() {
    clearWorkbook();
    setErr(null);
    setDone(null);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setDone(null);
    setPlan(null);
    setOpenSheet(null);
    setFileName(file.name);
    let parsed: WorkbookSheet[];
    try {
      parsed = await parseXlsx(await file.arrayBuffer());
    } catch (e) {
      setSheets([]);
      setErr(`Could not read ${file.name}: ${e instanceof Error ? e.message : "unreadable file"}`);
      return;
    }
    setSheets(parsed);
    start(async () => {
      try {
        setPlan(await preview(parsed));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "preview failed");
      }
    });
  }

  function onApply() {
    setErr(null);
    start(async () => {
      const res = await apply(sheets);
      if (res.error) {
        setErr(res.error);
        return;
      }
      if (res.result) {
        setDone(summarize(res.result));
        clearWorkbook();
        router.refresh();
      }
    });
  }

  const changes = plan ? plan.labsToCreate + plan.studentsToCreate + plan.studentsToUpdate + plan.membersToAdd : 0;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each sheet (tab) becomes a lab named after the tab, e.g. <code>Geng_Yuan_Lab</code>. Columns:{" "}
        <code>First Name</code>, <code>Last Name</code>, <code>UGA ID</code>, <code>Email</code>,{" "}
        <code>MS or PhD</code>. The UGA ID is the login username, and the row marked{" "}
        <code>Faculty</code> becomes the lab&apos;s PI. Labs that do not exist yet are created — no need
        to add them by hand first. This imports roster information only; grant each lab node access
        afterwards to provision it. Re-uploading the same workbook changes nothing.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="hidden"
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          Choose workbook…
        </Button>
        {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
        {plan && plan.ok && changes > 0 && (
          <Button type="button" onClick={onApply} disabled={pending}>
            {pending
              ? "Working…"
              : plan.labsToCreate > 0
                ? `Create ${plan.labsToCreate} lab${plan.labsToCreate === 1 ? "" : "s"} & import`
                : "Import roster changes"}
          </Button>
        )}
        {(plan || err) && (
          <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
            Clear
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {done && <p className="text-sm text-primary">{done}</p>}

      {plan && (
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <div className="grid grid-cols-1 gap-x-2 gap-y-1 text-sm sm:grid-cols-3">
            {(
              [
                ["Labs to create", plan.labsToCreate],
                ["Accounts to create", plan.studentsToCreate],
                ["Accounts to update", plan.studentsToUpdate],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="flex items-center justify-between gap-2 px-2 py-1">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-semibold tabular-nums">{n}</span>
              </div>
            ))}
          </div>

          {plan.issues.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <ul className="list-inside list-disc">
                {plan.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sheet</TableHead>
                <TableHead>Lab</TableHead>
                <TableHead>PI</TableHead>
                <TableHead>People</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.labs.map((lab) => {
                const open = openSheet === lab.sheet;
                return (
                  <Fragment key={lab.sheet}>
                    <TableRow className={cn(lab.ok ? undefined : "opacity-70", open && "bg-muted/40")}>
                      <TableCell className="whitespace-nowrap">
                        <button
                          type="button"
                          disabled={lab.people.length === 0}
                          aria-expanded={open}
                          onClick={() => setOpenSheet(open ? null : lab.sheet)}
                          className={cn(
                            "-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors",
                            lab.people.length === 0
                              ? "cursor-default"
                              : "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          )}
                        >
                          {lab.people.length > 0 && (
                            <ChevronDown
                              className={cn(
                                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                open && "rotate-180 text-foreground",
                              )}
                            />
                          )}
                          {lab.sheet}
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {lab.lab || "—"}{" "}
                        <Badge variant={lab.labExists ? "warn" : "ok"}>{lab.labExists ? "exists" : "new"}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{lab.piUsername ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {lab.people.length} · {lab.membersToAdd} to add
                      </TableCell>
                      <TableCell className={lab.ok ? "text-ok" : "text-err"}>
                        {lab.ok ? (
                          lab.warnings.length > 0 ? (
                            <span className="text-muted-foreground">{lab.warnings.join("; ")}</span>
                          ) : (
                            "ok"
                          )
                        ) : (
                          lab.issues.map((i) => (i.line ? `row ${i.line}: ${i.message}` : i.message)).join("; ")
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="p-2">
                          <LabRoster lab={lab} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>

          {plan.ok && changes === 0 && (
            <p className="text-sm text-muted-foreground">Nothing to change — every lab and member is already up to date.</p>
          )}
          {!plan.ok && (
            <p className="text-sm font-medium text-destructive">
              Fix the problems above in the workbook and choose it again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

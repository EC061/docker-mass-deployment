"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { parseXlsx } from "@/lib/xlsx";
import type {
  WorkbookAccount,
  WorkbookImportPlan,
  WorkbookImportResult,
  WorkbookSheet,
} from "@/lib/workbookimport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Props {
  preview: (sheets: WorkbookSheet[]) => Promise<WorkbookImportPlan>;
  apply: (sheets: WorkbookSheet[]) => Promise<{ result?: WorkbookImportResult; error?: string }>;
}

/** Which of the four summary counters is expanded to show the people (or labs) behind it. */
type Detail = "labs" | "create" | "update" | "members";

function AccountList({ accounts }: { accounts: WorkbookAccount[] }) {
  return (
    <ul className="divide-y divide-border/60">
      {accounts.map((a) => (
        <li key={a.username} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
          <code className="text-foreground">{a.username}</code>
          <span>{a.name ?? "—"}</span>
          <span className="text-muted-foreground">{a.email ?? "no email"}</span>
          <span className="ml-auto text-muted-foreground">{a.labs.join(", ")}</span>
        </li>
      ))}
    </ul>
  );
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

/**
 * The people (or labs) behind one summary counter. Roster additions overlap the account counters on
 * purpose — an account is a login, a roster addition is a lab membership — so the overlap is spelled
 * out rather than left for the reader to work out from two numbers that often match.
 */
function ImportDetail({ plan, detail }: { plan: WorkbookImportPlan; detail: Detail }) {
  const alsoNew = plan.rosterAdditions.filter((m) => m.newAccount).length;
  const body = {
    labs: {
      note: "Sheets naming a lab that does not exist yet. Each is created with the roster below it.",
      list: (
        <ul className="flex flex-wrap gap-1.5 py-1.5">
          {plan.newLabs.map((lab) => (
            <li key={lab}>
              <Badge variant="ok">{lab}</Badge>
            </li>
          ))}
        </ul>
      ),
    },
    create: {
      note: "People with no account yet — a login is created for each, once, however many labs list them.",
      list: <AccountList accounts={plan.accountsToCreate} />,
    },
    update: {
      note: "People who already have an account whose name, email, degree, or UGA ID the workbook changes.",
      list: <AccountList accounts={plan.accountsToUpdate} />,
    },
    members: {
      note:
        `One row per person per lab — this is lab membership, not a login, so it counts people who ` +
        `already have an account joining a lab. ${alsoNew} of ${plan.rosterAdditions.length} also ` +
        `need an account created.`,
      list: (
        <ul className="divide-y divide-border/60">
          {plan.rosterAdditions.map((m) => (
            <li key={`${m.lab}/${m.username}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
              <code className="text-foreground">{m.username}</code>
              <span>{m.name ?? "—"}</span>
              {m.isPi && <Badge variant="default">PI</Badge>}
              <Badge variant={m.newAccount ? "ok" : "secondary"}>
                {m.newAccount ? "new account" : "existing account"}
              </Badge>
              <span className="ml-auto text-muted-foreground">{m.lab}</span>
            </li>
          ))}
        </ul>
      ),
    },
  }[detail];

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs">
      <p className="text-muted-foreground">{body.note}</p>
      {body.list}
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
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pending, start] = useTransition();

  /** Drop the chosen workbook and its preview, leaving any success/error message on screen. */
  function clearWorkbook() {
    setSheets([]);
    setPlan(null);
    setDetail(null);
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
    setDetail(null);
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
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm sm:grid-cols-4">
            {(
              [
                ["labs", "Labs to create", plan.labsToCreate],
                ["create", "Accounts to create", plan.studentsToCreate],
                ["update", "Accounts to update", plan.studentsToUpdate],
                ["members", "Roster additions", plan.membersToAdd],
              ] as const
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                disabled={n === 0}
                aria-expanded={detail === key}
                onClick={() => setDetail(detail === key ? null : key)}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left transition-colors",
                  n === 0
                    ? "cursor-default"
                    : "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  detail === key && "bg-muted ring-1 ring-border",
                )}
              >
                <span className={cn("text-muted-foreground", detail === key && "text-foreground")}>{label}</span>
                <span className="flex items-center gap-1">
                  <span className="font-semibold tabular-nums">{n}</span>
                  {n > 0 && (
                    <ChevronDown
                      className={cn(
                        "size-3.5 text-muted-foreground transition-transform",
                        detail === key && "rotate-180 text-foreground",
                      )}
                    />
                  )}
                </span>
              </button>
            ))}
          </div>

          {detail && <ImportDetail plan={plan} detail={detail} />}

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
              {plan.labs.map((lab) => (
                <TableRow key={lab.sheet} className={lab.ok ? undefined : "opacity-70"}>
                  <TableCell className="whitespace-nowrap">{lab.sheet}</TableCell>
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
              ))}
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

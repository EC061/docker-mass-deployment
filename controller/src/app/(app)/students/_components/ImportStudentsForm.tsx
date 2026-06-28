"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { applyMapping, parseCsv, type ImportRow } from "@/lib/csv";
import type { ImportResult } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface LabOpt {
  id: number;
  name: string;
}

interface Props {
  labs: LabOpt[];
  // The server action is passed in so this client component stays decoupled from "use server" imports.
  importAction: (input: {
    labId: number;
    rows: { username?: string; email?: string; name?: string; studentId?: string }[];
    requireEmail?: boolean;
  }) => Promise<ImportResult>;
}

const PREVIEW_LIMIT = 50;

export function ImportStudentsForm({ labs, importAction }: Props) {
  const router = useRouter();
  const [labId, setLabId] = useState<number>(0);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string>("");
  const [cols, setCols] = useState({ username: "username", email: "email", name: "name", studentId: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Parse + validate entirely in the browser; only the resulting rows are sent on submit.
  const { headers, rows } = useMemo(() => {
    if (!csvText.trim()) return { headers: [] as string[], rows: [] as ImportRow[] };
    const parsed = parseCsv(csvText);
    const mapping = {
      username: cols.username || "username",
      email: cols.email || undefined,
      name: cols.name || undefined,
      studentId: cols.studentId || undefined,
    };
    return { headers: parsed.headers, rows: applyMapping(parsed, mapping) };
  }, [csvText, cols]);

  const validRows = rows.filter((r) => r.issues.length === 0);
  const invalidCount = rows.length - validRows.length;
  const set = (patch: Partial<typeof cols>) => setCols((c) => ({ ...c, ...patch }));

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setCsvText(await file.text());
  }

  async function onImport() {
    setResult(null);
    if (!labId) {
      setResult({ added: 0, skipped: 0, error: "Select a target lab" });
      return;
    }
    if (validRows.length === 0) {
      setResult({ added: 0, skipped: 0, error: "No valid rows to import" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await importAction({
        labId,
        requireEmail: !!cols.email,
        rows: validRows.map((r) => ({
          username: r.username,
          email: r.email,
          name: r.name,
          studentId: r.studentId,
        })),
      });
      setResult(res);
      if (res.added > 0) {
        setCsvText("");
        setFileName("");
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (labs.length === 0) return <p className="text-sm text-muted-foreground">Create a lab first.</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <Label>Target lab</Label>
          <Select value={labId} onChange={(e) => setLabId(Number(e.target.value))}>
            <option value={0} disabled>
              Select lab…
            </option>
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Username column</Label>
          <Input value={cols.username} onChange={(e) => set({ username: e.target.value })} />
        </div>
        <div>
          <Label>Email column</Label>
          <Input value={cols.email} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div>
          <Label>Name column</Label>
          <Input value={cols.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <Label>Student ID column</Label>
          <Input
            value={cols.studentId}
            placeholder="(optional)"
            onChange={(e) => set({ studentId: e.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div>
          <Label>CSV file</Label>
          <Input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
      </div>

      <div>
        <Label>…or paste CSV (first row = headers)</Label>
        <Textarea
          value={csvText}
          onChange={(e) => {
            setCsvText(e.target.value);
            setResult(null);
          }}
          rows={6}
          className="font-mono"
          placeholder={"username,email,name\nalice,alice@uga.edu,Alice A."}
        />
      </div>

      {rows.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm">
            <strong>{validRows.length}</strong> valid
            {invalidCount > 0 && (
              <>
                , <span className="text-err">{invalidCount}</span> will be skipped
              </>
            )}
            {headers.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {" "}· detected columns: {headers.join(", ")}
              </span>
            )}
          </p>
          <div className="max-h-80 overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Student ID</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
                  <TableRow key={i} className={r.issues.length ? "opacity-60" : undefined}>
                    <TableCell>{r.username || "—"}</TableCell>
                    <TableCell>{r.email ?? "—"}</TableCell>
                    <TableCell>{r.name ?? "—"}</TableCell>
                    <TableCell>{r.studentId ?? "—"}</TableCell>
                    <TableCell className={r.issues.length ? "text-err" : "text-ok"}>
                      {r.issues.length ? r.issues.join("; ") : "ok"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {rows.length > PREVIEW_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Showing first {PREVIEW_LIMIT} of {rows.length} rows.
            </p>
          )}
        </div>
      )}

      {result && (
        <p className={`text-sm ${result.error ? "text-err" : "text-ok"}`}>
          {result.error ? result.error : `Imported ${result.added}, skipped ${result.skipped}.`}
        </p>
      )}

      <Button
        type="button"
        onClick={onImport}
        disabled={submitting || validRows.length === 0 || !labId}
      >
        {submitting ? "Importing…" : `Import ${validRows.length} student${validRows.length === 1 ? "" : "s"}`}
      </Button>
      <p className="text-xs text-muted-foreground">
        The CSV is parsed in your browser; only the rows above are sent. Rows with a
        missing/invalid/duplicate username (or missing email when an email column is given) are skipped.
      </p>
    </div>
  );
}

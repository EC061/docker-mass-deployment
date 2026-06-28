"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { applyMapping, parseCsv, type ImportRow } from "@/lib/csv";
import type { ImportResult } from "../actions";

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

  if (labs.length === 0) return <p className="muted">Create a lab first.</p>;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <label>Target lab</label>
          <select value={labId} onChange={(e) => setLabId(Number(e.target.value))}>
            <option value={0} disabled>
              Select lab…
            </option>
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Username column</label>
          <input value={cols.username} onChange={(e) => set({ username: e.target.value })} />
        </div>
        <div>
          <label>Email column</label>
          <input value={cols.email} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div>
          <label>Name column</label>
          <input value={cols.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label>Student ID column</label>
          <input
            value={cols.studentId}
            placeholder="(optional)"
            onChange={(e) => set({ studentId: e.target.value })}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <label>CSV file</label>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        {fileName && <span className="muted" style={{ fontSize: 12 }}>{fileName}</span>}
      </div>

      <label style={{ marginTop: 10 }}>…or paste CSV (first row = headers)</label>
      <textarea
        value={csvText}
        onChange={(e) => {
          setCsvText(e.target.value);
          setResult(null);
        }}
        rows={6}
        style={{
          width: "100%",
          fontFamily: "monospace",
          background: "var(--panel-2)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 7,
          padding: 10,
        }}
        placeholder={"username,email,name\nalice,alice@uga.edu,Alice A."}
      />

      {rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: "6px 0" }}>
            <strong>{validRows.length}</strong> valid
            {invalidCount > 0 && (
              <>
                , <span style={{ color: "var(--danger, #e06)" }}>{invalidCount}</span> will be skipped
              </>
            )}
            {headers.length > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                {" "}· detected columns: {headers.join(", ")}
              </span>
            )}
          </p>
          <div className="table-wrap" style={{ maxHeight: 320, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Student ID</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
                  <tr key={i} style={r.issues.length ? { opacity: 0.6 } : undefined}>
                    <td>{r.username || "—"}</td>
                    <td>{r.email ?? "—"}</td>
                    <td>{r.name ?? "—"}</td>
                    <td>{r.studentId ?? "—"}</td>
                    <td style={{ color: r.issues.length ? "var(--danger, #e06)" : "var(--ok)" }}>
                      {r.issues.length ? r.issues.join("; ") : "ok"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_LIMIT && (
            <p className="muted" style={{ fontSize: 12 }}>
              Showing first {PREVIEW_LIMIT} of {rows.length} rows.
            </p>
          )}
        </div>
      )}

      {result && (
        <p style={{ color: result.error ? "var(--danger, #e06)" : "var(--ok)" }}>
          {result.error ? result.error : `Imported ${result.added}, skipped ${result.skipped}.`}
        </p>
      )}

      <button
        type="button"
        onClick={onImport}
        disabled={submitting || validRows.length === 0 || !labId}
        style={{ width: 200, marginTop: 8 }}
      >
        {submitting ? "Importing…" : `Import ${validRows.length} student${validRows.length === 1 ? "" : "s"}`}
      </button>
      <p className="muted" style={{ fontSize: 12 }}>
        The CSV is parsed in your browser; only the rows above are sent. Rows with a
        missing/invalid/duplicate username (or missing email when an email column is given) are skipped.
      </p>
    </div>
  );
}

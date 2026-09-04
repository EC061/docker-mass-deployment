/**
 * Markdown pipe tables in email bodies.
 *
 * Admins write tables the GitHub way:
 *
 *   | Server  | Deadline     |
 *   | ------- | ------------ |
 *   | Asimov1 | Saturday …   |
 *
 * Plain text stays the source of truth — every email still sends its `text` part unchanged.
 * This module detects those tables so two consumers can render them:
 *
 * - the mailer (`lib/mailer.ts`) attaches an `html` alternative with real <table>s, styled
 *   inline because email clients strip <style> blocks and classes;
 * - the announcement compose form splits the live preview into text/table segments and renders
 *   the tables with app styling, so the preview shows what recipients will see.
 *
 * No markdown dependency: the parser only knows pipe tables, so normal prose containing a
 * bare `|` is never mistaken for one (a header alone is not enough — it needs the delimiter
 * row underneath, and at least one body row).
 */

export type EmailTableAlign = "left" | "center" | "right";

export interface EmailTable {
  headers: string[];
  aligns: EmailTableAlign[];
  rows: string[][];
}

export type EmailBodySegment = { type: "text"; text: string } | { type: "table"; table: EmailTable };

/** Escape text for insertion into HTML (cell contents and prose alike are admin-authored). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Split one line into pipe-separated cells, tolerating missing outer pipes. */
function splitTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|").map((cell) => cell.trim());
  if (cells.length === 0 || cells.every((cell) => cell === "")) return null;
  return cells;
}

/**
 * Parse a delimiter row (`| --- | :---: | ---: |`) into per-column alignment, or null when
 * the line is not one. Each cell is optional colons around one or more dashes.
 */
function parseDelimiterRow(line: string): EmailTableAlign[] | null {
  const cells = splitTableRow(line);
  if (!cells) return null;
  const aligns: EmailTableAlign[] = [];
  for (const cell of cells) {
    const match = /^(:?)-+(:?)$/.exec(cell);
    if (!match) return null;
    aligns.push(match[1] && match[2] ? "center" : match[2] ? "right" : "left");
  }
  return aligns;
}

/**
 * Split a rendered email body into prose and table segments. Consecutive prose lines are
 * merged into one segment so the preview can render each chunk in a single block.
 */
export function splitEmailBody(body: string): EmailBodySegment[] {
  const lines = body.split("\n");
  const segments: EmailBodySegment[] = [];
  const textLines: string[] = [];

  const flushText = () => {
    // Drop the blank lines that separated a table from the prose — the preview lays the
    // segments out with its own spacing, and the email HTML does the same with margins.
    const text = textLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    textLines.length = 0;
    if (text) segments.push({ type: "text", text });
  };

  let i = 0;
  while (i < lines.length) {
    const headers = splitTableRow(lines[i] ?? "");
    const aligns = i + 1 < lines.length ? parseDelimiterRow(lines[i + 1] ?? "") : null;
    if (headers && aligns && aligns.length === headers.length) {
      const rows: string[][] = [];
      let j = i + 2;
      // At least one body row is required — a header plus delimiter alone is prose, not a table.
      while (j < lines.length) {
        const cells = splitTableRow(lines[j] ?? "");
        if (!cells) break;
        const row = headers.map((_, col) => cells[col] ?? "");
        rows.push(row);
        j += 1;
      }
      if (rows.length > 0) {
        flushText();
        segments.push({ type: "table", table: { headers, aligns, rows } });
        i = j;
        continue;
      }
    }
    textLines.push(lines[i] ?? "");
    i += 1;
  }
  flushText();
  return segments;
}

/** Whether the body contains at least one pipe table (and so warrants an HTML alternative). */
export function hasMarkdownTable(body: string): boolean {
  return splitEmailBody(body).some((segment) => segment.type === "table");
}

function alignStyle(align: EmailTableAlign): string {
  return align === "left" ? "" : ` text-align:${align};`;
}

/** One table rendered as a self-contained email-safe fragment (inline styles only). */
export function renderEmailTableHtml(table: EmailTable): string {
  const th = (cell: string, align: EmailTableAlign) =>
    `<th style="border:1px solid #d1d5db;padding:8px 12px;background-color:#f3f4f6;font-weight:600;text-align:left;${alignStyle(align)}">${escapeHtml(cell)}</th>`;
  const td = (cell: string, align: EmailTableAlign) =>
    `<td style="border:1px solid #d1d5db;padding:8px 12px;vertical-align:top;${alignStyle(align)}">${escapeHtml(cell)}</td>`;
  const head = table.headers.map((cell, col) => th(cell, table.aligns[col] ?? "left")).join("");
  const body = table.rows
    .map((row) => `<tr>${row.map((cell, col) => td(cell, table.aligns[col] ?? "left")).join("")}</tr>`)
    .join("");
  return (
    `<table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:16px 0;">` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** Prose rendered as email-safe HTML, preserving the blank-line/line-break shape of the text part. */
function renderEmailTextHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px 0;">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Render the final plain-text email body (signature already appended) as an HTML alternative.
 * Returns undefined when there is no table so the mailer keeps sending text-only mail exactly
 * as before — most clients then show the same text, and existing behaviour is untouched.
 */
export function renderEmailHtml(text: string): string | undefined {
  const segments = splitEmailBody(text);
  if (!segments.some((segment) => segment.type === "table")) return undefined;
  const inner = segments
    .map((segment) =>
      segment.type === "table" ? renderEmailTableHtml(segment.table) : renderEmailTextHtml(segment.text),
    )
    .join("");
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.6;color:#111827;">${inner}</div>`
  );
}

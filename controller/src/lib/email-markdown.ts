/**
 * Minimal Markdown for email bodies (dependency-free).
 *
 * Admins write announcements and templates as plain text; this renders the Markdown they reach
 * for — headings, **bold**, *italic*, ~~strikethrough~~, `code`, fenced code blocks, [links],
 * bullet/numbered lists, > quotes, horizontal rules, and pipe tables — in two places that must
 * agree:
 *
 * - the mailer attaches an `html` alternative with real elements, styled inline because email
 *   clients strip <style> blocks and classes;
 * - the announcement compose form parses the same blocks for its live preview.
 *
 * Everything is escaped before any markup is recognized, links are limited to http/https/mailto,
 * and images render as their alt text (remote images are blocked by most clients anyway). The
 * plain-text part is always sent unchanged; bodies with no Markdown stay text-only.
 */

import {
  escapeHtml,
  matchTableAt,
  renderEmailTableHtml,
  type EmailTable,
} from "./email-tables";

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; table: EmailTable };

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^\s{0,3}(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** Split a body into blocks. Blank lines separate paragraphs; nothing else is required. */
export function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const lines = body.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1] ?? "```";
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trimStart().startsWith(mark[0].repeat(3))) {
        code.push(lines[j] ?? "");
        j += 1;
      }
      blocks.push({ type: "code", text: code.join("\n").replace(/^\n+/, "").replace(/\n+$/, "") });
      i = j + 1;
      continue;
    }

    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      const level = Math.min(Math.max(heading[1]?.length ?? 1, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text: heading[2] ?? "" });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: quoted.join("\n") });
      continue;
    }

    const listMatch = LIST_RE.exec(line);
    if (listMatch) {
      const ordered = listMatch[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i] ?? "");
        if (!m || (m[2] !== undefined) !== ordered) break;
        // A `- [ ]` / `- [x]` prefix renders as a ballot-box marker, not a nested list.
        items.push((m[3] ?? "").replace(/^\[( |x|X)\]\s+/, (_, box: string) => (box === " " ? "☐ " : "☒ ")));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const table = matchTableAt(lines, i);
    if (table) {
      blocks.push({ type: "table", table: table.table });
      i = table.next;
      continue;
    }

    const prose: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !HEADING_RE.test((lines[i] ?? "").trim()) &&
      !HR_RE.test(lines[i] ?? "") &&
      !LIST_RE.test(lines[i] ?? "") &&
      !FENCE_RE.test(lines[i] ?? "") &&
      !/^\s{0,3}>\s?/.test(lines[i] ?? "") &&
      !matchTableAt(lines, i)
    ) {
      prose.push(lines[i] ?? "");
      i += 1;
    }
    if (prose.length > 0) blocks.push({ type: "paragraph", text: prose.join("\n") });
    else i += 1;
  }

  return blocks;
}

const INLINE_CODE_RE = /`([^`\n]+)`/;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s\n]+)(?:\s+"[^"\n]*")?\)/;
// Markers must hug their content (`a * b` and snake_case stay literal).
const BOLD_RE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/;
const STRIKE_RE = /~~(?=\S)(.+?)(?<=\S)~~/;
const ITALIC_STAR_RE = /\*(?=\S)([^*\n]+?)(?<=\S)\*/;
const ITALIC_UNDER_RE = /(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/;

/** Links are limited to schemes a mail client can safely open; anything else renders as text. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  return null;
}

/**
 * Render inline Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`) as
 * HTML. Input is escaped first, so template text can never inject markup; code spans are lifted
 * out before the other passes so their contents are never re-interpreted.
 */
export function renderInlineHtml(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background-color:#f3f4f6;padding:1px 4px;border-radius:4px;">${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(LINK_RE, (whole, label: string, url: string) => {
      const href = safeHref(url);
      return href
        ? `<a href="${escapeHtml(href)}" style="color:#1d4ed8;text-decoration:underline;">${label}</a>`
        : whole;
    })
    .replace(BOLD_RE, "<strong>$2</strong>")
    .replace(STRIKE_RE, "<del>$1</del>")
    .replace(ITALIC_STAR_RE, "<em>$1</em>")
    .replace(ITALIC_UNDER_RE, "<em>$1</em>");
  // A second bold pass catches `*` pairs nested inside a `**` span's remainder; loops are
  // impossible (each pass strictly shortens the marker count) — one repeat is enough.
  out = out.replace(BOLD_RE, "<strong>$2</strong>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)] ?? "");
}

/** Whether the text carries any inline Markdown worth an HTML alternative. */
export function hasInlineMarkdown(text: string): boolean {
  return (
    INLINE_CODE_RE.test(text) ||
    LINK_RE.test(text) ||
    BOLD_RE.test(text) ||
    STRIKE_RE.test(text) ||
    ITALIC_STAR_RE.test(text) ||
    ITALIC_UNDER_RE.test(text)
  );
}

/** Whether the body has any Markdown (blocks or inline) and so warrants an HTML alternative. */
export function hasMarkdown(body: string): boolean {
  return parseMarkdownBlocks(body).some((block) =>
    block.type === "paragraph" ? hasInlineMarkdown(block.text) : true,
  );
}

function renderParagraphHtml(text: string): string {
  return `<p style="margin:0 0 12px 0;">${renderInlineHtml(text).replace(/\n/g, "<br>")}</p>`;
}

/** One block as email-safe HTML (inline styles only — clients strip classes and <style>). */
export function renderBlockHtml(block: MarkdownBlock): string {
  switch (block.type) {
    case "heading": {
      const size = block.level <= 1 ? 20 : block.level === 2 ? 17 : 15;
      return `<h${block.level} style="font-size:${size}px;line-height:1.4;margin:16px 0 8px 0;font-weight:700;">${renderInlineHtml(block.text)}</h${block.level}>`;
    }
    case "paragraph":
      return renderParagraphHtml(block.text);
    case "quote":
      return `<blockquote style="margin:0 0 12px 0;padding:4px 0 4px 12px;border-left:3px solid #d1d5db;color:#374151;">${renderInlineHtml(block.text).replace(/\n/g, "<br>")}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li style="margin:2px 0;">${renderInlineHtml(item)}</li>`)
        .join("");
      return `<${tag} style="margin:0 0 12px 0;padding-left:24px;">${items}</${tag}>`;
    }
    case "code":
      return `<pre style="margin:0 0 12px 0;padding:12px;background-color:#f3f4f6;border-radius:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(block.text)}</pre>`;
    case "hr":
      return `<hr style="border:none;border-top:1px solid #d1d5db;margin:16px 0;">`;
    case "table":
      return renderEmailTableHtml(block.table);
  }
}

/**
 * Render the final plain-text email body (signature already appended) as an HTML alternative.
 * Returns undefined when there is no Markdown so the mailer keeps sending text-only mail exactly
 * as before — most clients then show the same text, and existing behaviour is untouched.
 */
export function renderMarkdownEmailHtml(text: string): string | undefined {
  const blocks = parseMarkdownBlocks(text);
  if (!hasMarkdown(text)) return undefined;
  const inner = blocks.map(renderBlockHtml).join("");
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.6;color:#111827;">${inner}</div>`
  );
}

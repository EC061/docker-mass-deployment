import { describe, expect, it } from "vitest";
import {
  hasInlineMarkdown,
  hasMarkdown,
  parseMarkdownBlocks,
  renderInlineHtml,
  renderMarkdownEmailHtml,
} from "../src/lib/email-markdown";

const SERVER_TABLE = [
  "| Server  | Data Transfer Deadline / Renovation Begins | Expected Recovery                  |",
  "| ------- | ------------------------------------------ | ---------------------------------- |",
  "| Asimov1 | Saturday, September 12 at 11:59 PM ET      | Monday, September 14 by 8:00 AM ET |",
].join("\n");

describe("parseMarkdownBlocks", () => {
  it("parses headings, lists, quotes, code, rules, and tables alongside prose", () => {
    const blocks = parseMarkdownBlocks(
      [
        "## Downtime",
        "",
        "Heads up:",
        "",
        "- Asimov1",
        "- Asimov2",
        "",
        "1. Save work",
        "2. Log out",
        "",
        "> Midnight window",
        "",
        "```",
        "squeue -u $USER",
        "```",
        "",
        "---",
        "",
        SERVER_TABLE,
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "hr",
      "table",
    ]);
    const [heading, , bullets, numbered, quote, code, , table] = blocks;
    if (heading?.type !== "heading") throw new Error("expected a heading");
    expect(heading.level).toBe(2);
    expect(heading.text).toBe("Downtime");
    if (bullets?.type !== "list" || numbered?.type !== "list") throw new Error("expected lists");
    expect(bullets.ordered).toBe(false);
    expect(bullets.items).toEqual(["Asimov1", "Asimov2"]);
    expect(numbered.ordered).toBe(true);
    expect(numbered.items).toEqual(["Save work", "Log out"]);
    if (quote?.type !== "quote" || code?.type !== "code") throw new Error("expected quote + code");
    expect(quote.text).toBe("Midnight window");
    expect(code.text).toBe("squeue -u $USER");
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.table.headers[0]).toBe("Server");
  });

  it("renders task-list markers as ballot boxes, not nested lists", () => {
    const blocks = parseMarkdownBlocks("- [ ] save\n- [x] done");
    if (blocks[0]?.type !== "list") throw new Error("expected a list");
    expect(blocks[0].items).toEqual(["☐ save", "☒ done"]);
  });

  it("parses lists from Windows (CRLF) line endings, e.g. pasted from Word/Outlook", () => {
    const blocks = parseMarkdownBlocks("* Asimov1 wipe: Sep 12\r\n* Asimov2 wipe: Sep 18\r\n");
    if (blocks[0]?.type !== "list") throw new Error("expected a list");
    expect(blocks[0].items).toEqual(["Asimov1 wipe: Sep 12", "Asimov2 wipe: Sep 18"]);
  });
});

describe("renderInlineHtml", () => {
  it("renders bold, italic, strikethrough, code, and links", () => {
    expect(renderInlineHtml("**down** and *soon*")).toBe("<strong>down</strong> and <em>soon</em>");
    expect(renderInlineHtml("__down__ and _soon_")).toBe("<strong>down</strong> and <em>soon</em>");
    expect(renderInlineHtml("~~gone~~ and `squeue`")).toContain("<del>gone</del>");
    expect(renderInlineHtml("see [docs](https://example.com/x)")).toContain(
      '<a href="https://example.com/x"',
    );
  });

  it("leaves snake_case, math, and unsafe links literal", () => {
    expect(hasInlineMarkdown("max_connections and a * b")).toBe(false);
    expect(renderInlineHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(renderInlineHtml("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

describe("renderMarkdownEmailHtml", () => {
  it("returns undefined for plain prose, keeping mail text-only", () => {
    expect(renderMarkdownEmailHtml("Hello\n\nNo formatting here.")).toBeUndefined();
    expect(hasMarkdown("Hello\n\nNo formatting here.")).toBe(false);
  });

  it("renders the downtime table with inline styles and keeps the prose", () => {
    const html = renderMarkdownEmailHtml(`Heads up:\n\n${SERVER_TABLE}`);
    expect(html).toContain("<table");
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("Asimov1");
    expect(html).not.toContain("| Server");
  });

  it("renders headings, bold, lists, and code as email-safe HTML", () => {
    const html = renderMarkdownEmailHtml("## Downtime\n\n**Save** your work:\n\n- Asimov1\n\n`squeue`");
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>Save</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
  });

  it("renders lists from a CRLF body without leaking carriage returns", () => {
    const html = renderMarkdownEmailHtml("* Asimov1 wipe: Sep 12\r\n* Asimov2 wipe: Sep 18\r\n");
    expect(html).toContain("<ul");
    expect(html).toContain("Asimov1 wipe: Sep 12");
    expect(html).not.toContain("\r");
  });
});

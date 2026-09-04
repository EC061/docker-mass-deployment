import { describe, expect, it } from "vitest";
import {
  hasMarkdownTable,
  renderEmailTableHtml,
  splitEmailBody,
} from "../src/lib/email-tables";

const SERVER_TABLE = [
  "| Server  | Data Transfer Deadline / Renovation Begins | Expected Recovery                  |",
  "| ------- | ------------------------------------------ | ---------------------------------- |",
  "| Asimov1 | Saturday, September 12 at 11:59 PM ET      | Monday, September 14 by 8:00 AM ET |",
  "| Asimov2 | Friday, September 18 at 11:59 PM ET        | Monday, September 21 by 8:00 AM ET |",
].join("\n");

describe("splitEmailBody", () => {
  it("parses the downtime table into headers and rows", () => {
    const segments = splitEmailBody(`Heads up:\n\n${SERVER_TABLE}\n\nThanks!`);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "Heads up:" });
    expect(segments[1]?.type).toBe("table");
    if (segments[1]?.type !== "table") throw new Error("expected a table segment");
    expect(segments[1].table.headers).toEqual([
      "Server",
      "Data Transfer Deadline / Renovation Begins",
      "Expected Recovery",
    ]);
    expect(segments[1].table.rows).toEqual([
      ["Asimov1", "Saturday, September 12 at 11:59 PM ET", "Monday, September 14 by 8:00 AM ET"],
      ["Asimov2", "Friday, September 18 at 11:59 PM ET", "Monday, September 21 by 8:00 AM ET"],
    ]);
    expect(segments[2]).toEqual({ type: "text", text: "Thanks!" });
  });

  it("reads column alignment from the delimiter row", () => {
    const segments = splitEmailBody("| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
    if (segments[0]?.type !== "table") throw new Error("expected a table segment");
    expect(segments[0].table.aligns).toEqual(["left", "center", "right"]);
  });

  it("leaves a lone pipe line and a header without body rows as prose", () => {
    expect(hasMarkdownTable("run a | b for details")).toBe(false);
    expect(hasMarkdownTable("| A | B |\n| --- | --- |")).toBe(false);
    expect(hasMarkdownTable("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
  });

  it("ignores a delimiter whose column count does not match the header", () => {
    expect(hasMarkdownTable("| A | B |\n| --- |\n| 1 | 2 |")).toBe(false);
  });
});

describe("renderEmailTableHtml", () => {
  it("escapes cell contents so template text cannot inject markup", () => {
    const html = renderEmailTableHtml({
      headers: ["A<script>"],
      aligns: ["left"],
      rows: [["<b>hi</b>"]],
    });
    expect(html).toContain("A&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });
});

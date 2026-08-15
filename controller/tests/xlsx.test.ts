import { describe, expect, it } from "vitest";
import { parseXlsx } from "../src/lib/xlsx";

/**
 * Build a ZIP in memory so the tests exercise the reader without shipping a binary fixture. Entries
 * are written either stored (method 0) or deflated (method 8) so both code paths are covered; the
 * CRC field is left zero because the reader (like most .xlsx consumers) does not verify it.
 */
async function makeZip(files: { name: string; text: string; deflate?: boolean }[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = encoder.encode(file.text);
    let data: Uint8Array = raw;
    if (file.deflate) {
      const stream = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      }).pipeThrough(new CompressionStream("deflate-raw"));
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.byteLength;
      }
    }

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, file.deflate ? 8 : 0, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, file.deflate ? 8 : 0, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, raw.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="x">
  <sheets>
    <sheet state="visible" name="Geng_Yuan_Lab" sheetId="1" r:id="rId5"/>
    <sheet state="visible" name="Wei_Niu_Lab" sheetId="2" r:id="rId6"/>
  </sheets></workbook>`;

const RELS = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId5" Target="worksheets/sheetA.xml"/>
  <Relationship Id="rId6" Target="/xl/worksheets/sheetB.xml"/>
</Relationships>`;

const SHARED = `<?xml version="1.0"?><sst>
  <si><t>First Name</t></si>
  <si><t>Last Name</t></si>
  <si><t>UGA ID</t></si>
  <si><t>Email</t></si>
  <si><t>MS or PhD</t></si>
  <si><r><t>Geng</t></r><r><t> &amp; co</t></r></si>
  <si><t>Yuan</t></si>
  <si><t>Faculty</t></si>
</sst>`;

// Row 1 is the header (shared strings), row 2 a person; column D uses an inline string, and the
// sheet deliberately skips a cell and carries a trailing empty row.
const SHEET_A = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
  <row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="str"><f>X</f><v>gy23443</v></c><c r="D2" t="inlineStr"><is><t>geng.yuan@uga.edu</t></is></c><c r="E2" t="s"><v>7</v></c></row>
  <row r="3"><c r="A3"/><c r="C3" t="e"><v>#REF!</v></c></row>
</sheetData></worksheet>`;

const SHEET_B = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>2</v></c><c r="C1" t="n"><v>42</v></c></row>
</sheetData></worksheet>`;

async function workbook(): Promise<ArrayBuffer> {
  return makeZip([
    { name: "xl/workbook.xml", text: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", text: RELS },
    { name: "xl/sharedStrings.xml", text: SHARED, deflate: true },
    { name: "xl/worksheets/sheetA.xml", text: SHEET_A, deflate: true },
    { name: "xl/worksheets/sheetB.xml", text: SHEET_B },
    { name: "xl/styles.xml", text: "<styleSheet/>" },
  ]);
}

describe("parseXlsx", () => {
  it("reads every sheet in tab order, resolving relationship targets", async () => {
    const sheets = await parseXlsx(await workbook());
    expect(sheets.map((s) => s.name)).toEqual(["Geng_Yuan_Lab", "Wei_Niu_Lab"]);
  });

  it("reads shared, inline, formula-cached and numeric cells", async () => {
    const [first, second] = await parseXlsx(await workbook());
    expect(first.rows[0]).toEqual(["First Name", "Last Name", "UGA ID", "Email", "MS or PhD"]);
    // Rich-text runs are concatenated and XML entities decoded.
    expect(first.rows[1]).toEqual(["Geng & co", "Yuan", "gy23443", "geng.yuan@uga.edu", "Faculty"]);
    expect(second.rows[0]).toEqual(["UGA ID", "", "42"]);
  });

  it("drops trailing blank rows and fills gaps", async () => {
    const [first] = await parseXlsx(await workbook());
    expect(first.rows).toHaveLength(2); // the empty/error-only third row is dropped
  });

  it("rejects files that are not workbooks", async () => {
    await expect(parseXlsx(new ArrayBuffer(0))).rejects.toThrow(/empty/);
    await expect(parseXlsx(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).rejects.toThrow(
      /not a valid .xlsx/,
    );
    const noWorkbook = await makeZip([{ name: "xl/sharedStrings.xml", text: SHARED }]);
    await expect(parseXlsx(noWorkbook)).rejects.toThrow(/xl\/workbook.xml is missing/);
  });
});

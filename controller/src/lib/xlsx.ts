/**
 * Minimal .xlsx reader — enough to turn the department's "Lab Information For Server Management"
 * workbook into one string grid per sheet, with no third-party dependency.
 *
 * An .xlsx file is a ZIP of XML parts. We read the ZIP central directory, inflate the parts we need
 * with the platform's DecompressionStream (browsers and Node both have it), and pull cell text out
 * of the sheet XML with a small scanner. Only what a roster needs is supported: shared/inline
 * strings, numbers and booleans as text. Formulas contribute their cached value; dates come through
 * as the raw Excel serial number (rosters are text, so this never bites in practice).
 *
 * This module is deliberately isomorphic: the Labs page parses the workbook in the browser and posts
 * only the resulting grids, so the binary never reaches the server (the server still re-validates
 * every row — see lib/workbookimport.ts).
 */

export interface XlsxSheet {
  /** Sheet (tab) name, e.g. "Geng_Yuan_Lab". */
  name: string;
  /** Row-major cell text, trimmed, with trailing blank rows/columns removed. */
  rows: string[][];
}

/** Workbooks this size are already far beyond any roster; refuse rather than chew through them. */
export const MAX_XLSX_BYTES = 5_000_000;
/** Cap on a single inflated part, so a malicious "zip bomb" cannot exhaust memory. */
const MAX_PART_BYTES = 50_000_000;
const MAX_SHEETS = 200;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_COLS_PER_SHEET = 64;

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// ---------------------------------------------------------------------------- zip

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PART_BYTES) {
      await reader.cancel();
      throw new Error("xlsx part is implausibly large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Read every file in the ZIP into a name -> UTF-8 text map. */
async function readZip(data: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();

  // End-of-central-directory record: last 22 bytes plus an optional comment (<= 64 KiB).
  let eocd = -1;
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid .xlsx file (no ZIP directory found)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("ZIP64 .xlsx files are not supported");

  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CDIR_SIG) {
      throw new Error("corrupt .xlsx file (bad ZIP directory entry)");
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Only the handful of parts a roster needs are inflated; skip images, themes, styles, …
    if (!wantedPart(name)) continue;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 .xlsx files are not supported");
    }
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error("corrupt .xlsx file (bad ZIP entry header)");
    }
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method ${method}`);
    files.set(name, decoder.decode(method === 0 ? raw : await inflateRaw(raw)));
  }
  return files;
}

function wantedPart(name: string): boolean {
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    (name.startsWith("xl/worksheets/") && name.endsWith(".xml"))
  );
}

// ---------------------------------------------------------------------------- xml

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity] ?? whole;
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

/** Concatenated text of every <t> element in a fragment (rich-text runs are joined). */
function textOf(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) strings.push(textOf(m[1] ?? ""));
  return strings;
}

/** "BC12" -> { col: 54, row: 12 } (both 0-based for col, 1-based for row). */
function cellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  let cursor = { col: 0, row: 1 }; // for the (rare) cell without an r="" reference
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = m[1] ?? "";
    const body = m[2] ?? "";
    const ref = attr(tag, "r");
    const at = ref ? cellRef(ref) : null;
    const col = at ? at.col : cursor.col;
    const row = at ? at.row : cursor.row;
    cursor = { col: col + 1, row };

    const type = attr(tag, "t") ?? "n";
    let text: string;
    if (type === "s") {
      const index = Number(textOf(body) || (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? ""));
      text = shared[index] ?? "";
    } else if (type === "inlineStr") {
      text = textOf(body);
    } else if (type === "e") {
      text = "";
    } else {
      const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      text = type === "b" ? (value === "1" ? "TRUE" : "FALSE") : unescapeXml(value);
    }
    text = text.trim();
    if (!text) continue;
    if (row > MAX_ROWS_PER_SHEET || col >= MAX_COLS_PER_SHEET) continue;
    const line = (grid[row - 1] ??= []);
    line[col] = text;
  }

  // Normalize: fill holes, drop trailing blank rows.
  const width = grid.reduce((n, line) => Math.max(n, line?.length ?? 0), 0);
  const rows = grid.map((line) => Array.from({ length: width }, (_, i) => line?.[i] ?? ""));
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------- workbook

/**
 * Parse a workbook into one string grid per sheet, in tab order. Throws with an admin-readable
 * message when the file is not a usable .xlsx.
 */
export async function parseXlsx(data: ArrayBuffer): Promise<XlsxSheet[]> {
  if (data.byteLength === 0) throw new Error("the file is empty");
  if (data.byteLength > MAX_XLSX_BYTES) {
    throw new Error(`the file is too large (max ${Math.round(MAX_XLSX_BYTES / 1_000_000)} MB)`);
  }
  const files = await readZip(data);
  const workbook = files.get("xl/workbook.xml");
  if (!workbook) throw new Error("not a valid .xlsx workbook (xl/workbook.xml is missing)");

  // rId -> part path, so sheets resolve in tab order even when the sheetN.xml numbering differs.
  const targets = new Map<string, string>();
  for (const m of (files.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (!id || !target) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }

  const shared = parseSharedStrings(files.get("xl/sharedStrings.xml"));
  const sheets: XlsxSheet[] = [];
  let ordinal = 0;
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    ordinal += 1;
    if (sheets.length >= MAX_SHEETS) break;
    const name = attr(m[0], "name");
    if (!name) continue;
    if (attr(m[0], "state") === "veryHidden") continue;
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    const path = (rid && targets.get(rid)) || `xl/worksheets/sheet${ordinal}.xml`;
    const xml = files.get(path);
    if (!xml) continue;
    sheets.push({ name: name.trim(), rows: parseSheet(xml, shared) });
  }
  if (sheets.length === 0) throw new Error("the workbook has no readable sheets");
  return sheets;
}

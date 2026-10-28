/**
 * The first sheet of an Excel file (.xlsx) as tab-separated lines, for
 * the team list. An .xlsx is a zip of XML files: the zip is read here and
 * its parts inflated with the browser's own DecompressionStream, so the
 * page needs no spreadsheet library for the Excel template.
 */

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

function entries(buf: ArrayBuffer): Entry[] {
  const view = new DataView(buf);
  // End of central directory: the last record, up to 64 kB of comment after it.
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Entry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n++) {
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    out.push({
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
      name: decoder.decode(new Uint8Array(buf, at + 46, nameLen)),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: ArrayBuffer, e: Entry): Promise<string> {
  const view = new DataView(buf);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("unsupported compression");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** "B" → 1, "AA" → 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

const textOf = (el: Element | null | undefined) => [...(el?.getElementsByTagName("t") ?? [])].map((t) => t.textContent ?? "").join("");

export async function readXlsxFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const list = entries(buf);
  const find = (name: string) => list.find((e) => e.name === name);
  const sheetEntry = find("xl/worksheets/sheet1.xml") ?? list.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!sheetEntry) throw new Error("no sheet");
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  const sharedEntry = find("xl/sharedStrings.xml");
  const shared = sharedEntry ? [...parse(await readEntry(buf, sharedEntry)).getElementsByTagName("si")].map((si) => textOf(si)) : [];

  const sheet = parse(await readEntry(buf, sheetEntry));
  const lines: string[] = [];
  for (const row of sheet.getElementsByTagName("row")) {
    const cells: string[] = [];
    let next = 0;
    for (const c of row.getElementsByTagName("c")) {
      const type = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      const value = type === "s" ? (shared[parseInt(v, 10)] ?? "") : type === "inlineStr" ? textOf(c.getElementsByTagName("is")[0]) : v;
      const ref = c.getAttribute("r");
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      cells[col] = value.replace(/[\t\r\n]+/g, " ");
    }
    lines.push(Array.from(cells, (x) => x ?? "").join("\t"));
  }
  return lines.join("\n");
}

/**
 * The team list: one row per player, typed in a table, pasted from a
 * spreadsheet or read from a CSV or Excel file.
 */

export interface Row {
  id: string;
  name: string;
  number: string;
  qty: number;
  /** Printed under the club logo; empty takes them from a full name. */
  initials?: string;
}

export function newRow(p: Partial<Row> = {}): Row {
  return { id: "r" + Math.random().toString(36).slice(2, 9), name: "", number: "", qty: 1, initials: "", ...p };
}

/** "Anna Andersson" → "AA". A single name gives none: "Andersson" is not enough. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (words.length < 2) return "";
  return words.map((w) => w[0]!).join("").toLocaleUpperCase("sv-SE").slice(0, 3);
}

/** What a row prints as initials: typed, or taken from the name. */
export function rowInitials(row: Row): string {
  return (row.initials ?? "").trim().toLocaleUpperCase("sv-SE") || initialsOf(row.name);
}

export function cleanInitials(v: string): string {
  return v.replace(/[^\p{L}.\s]/gu, "").toLocaleUpperCase("sv-SE").slice(0, 6);
}

const NUMBER = /^#?\d{1,3}$/;
const HEADER = /^(namn|name|spelare|player|nummer|number|nr|no|antal|qty|quantity|st|initialer|initials)$/i;

/** Column headings, as in the Excel template: Namn, Nummer, Initialer, Antal. */
const COLUMNS: { field: "name" | "number" | "initials" | "qty"; re: RegExp }[] = [
  { field: "name", re: /^(namn|name|spelare|player|efternamn|tryck)$/i },
  { field: "number", re: /^(nummer|number|nr|no|#|tröjnummer)$/i },
  { field: "initials", re: /^(initialer|initials|init)$/i },
  { field: "qty", re: /^(antal|qty|quantity|st)$/i },
];

/** Fields of a line. Not trimmed first: an empty first column keeps its place. */
function splitFields(line: string): string[] {
  const raw = line.replace(/^\uFEFF/, "");
  const delimiter = raw.includes("\t") ? "\t" : raw.includes(";") ? ";" : raw.includes(",") ? "," : null;
  return (delimiter ? raw.split(delimiter) : [raw]).map((f) => f.trim().replace(/^"(.*)"$/, "$1").trim());
}

/** A heading row's fields to columns, or null when the line is not one. */
function headerMap(line: string): ((typeof COLUMNS)[number]["field"] | null)[] | null {
  const fields = splitFields(line);
  if (fields.filter(Boolean).length < 2) return null;
  const map = fields.map((f) => COLUMNS.find((c) => c.re.test(f))?.field ?? null);
  return fields.some((f, i) => f && !map[i]) ? null : map;
}

function cleanNumber(v: string): string {
  return v.replace(/^#/, "").trim();
}

function cleanName(v: string): string {
  return v.replace(/\s+/g, " ").trim().slice(0, 30);
}

function cleanQty(v: string | undefined): number {
  const n = parseInt((v ?? "").trim(), 10);
  return n > 0 ? Math.min(999, n) : 1;
}

/** One line of a list into a row, whatever the order of its fields. */
function parseLine(line: string): Row | null {
  const raw = line.replace(/^﻿/, "").trim();
  if (!raw) return null;

  const delimiter = raw.includes("\t") ? "\t" : raw.includes(";") ? ";" : raw.includes(",") ? "," : null;
  let fields = delimiter ? raw.split(delimiter) : [raw];
  fields = fields.map((f) => f.trim().replace(/^"(.*)"$/, "$1").trim());

  if (!delimiter) {
    // "10 ANDERSSON" or "ANDERSSON 10"
    const numFirst = /^#?(\d{1,3})\s+(.+)$/.exec(raw);
    const numLast = /^(.+?)\s+#?(\d{1,3})$/.exec(raw);
    if (numFirst) fields = [numFirst[2]!, numFirst[1]!];
    else if (numLast) fields = [numLast[1]!, numLast[2]!];
  }

  const nonEmpty = fields.filter((f) => f !== "");
  if (nonEmpty.length === 0) return null;
  if (nonEmpty.every((f) => HEADER.test(f))) return null;

  if (fields.length === 1) {
    const f = fields[0]!;
    return NUMBER.test(f) ? newRow({ number: cleanNumber(f) }) : newRow({ name: cleanName(f) });
  }

  const [a = "", b = "", c] = fields;
  // Name, number[, qty] — or number, name[, qty]
  if (NUMBER.test(a) && !NUMBER.test(b) && b !== "") {
    return newRow({ number: cleanNumber(a), name: cleanName(b), qty: cleanQty(c) });
  }
  if (NUMBER.test(a) && NUMBER.test(b) && fields.length === 2) {
    // Two numbers: a number and how many.
    return newRow({ number: cleanNumber(a), qty: cleanQty(b) });
  }
  return newRow({ name: cleanName(a), number: NUMBER.test(b) ? cleanNumber(b) : "", qty: cleanQty(c) });
}

/**
 * A pasted list, a CSV file or an Excel sheet as tab-separated lines.
 * A heading row (Namn, Nummer, Initialer, Antal) says which column is
 * which; without one the fields are guessed line by line. Blank lines
 * are skipped.
 */
export function parseRoster(text: string): Row[] {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  const map = first >= 0 ? headerMap(lines[first]!) : null;
  const rows = map
    ? lines.slice(first + 1).map((line) => {
        const fields = splitFields(line);
        const get = (field: (typeof COLUMNS)[number]["field"]) => fields[map.indexOf(field)] ?? "";
        const number = cleanNumber(get("number"));
        return newRow({
          name: cleanName(get("name")),
          number: NUMBER.test(number) ? number : "",
          initials: map.includes("initials") ? cleanInitials(get("initials")) : "",
          qty: cleanQty(get("qty")),
        });
      })
    : lines.map(parseLine);
  return rows.filter((r): r is Row => r !== null && (r.name !== "" || r.number !== "" || (r.initials ?? "") !== ""));
}

/** CSV files from Excel in Sweden are often Latin-1; try UTF-8 first. */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8;
}

export function rowsToText(rows: Row[]): string {
  return rows
    .filter((r) => r.name || r.number)
    .map((r) => [r.name, r.number, r.qty > 1 ? String(r.qty) : ""].filter((v, i) => v !== "" || i < 2).join(", "))
    .join("\n");
}

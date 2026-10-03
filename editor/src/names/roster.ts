/**
 * The team list: one row per player, typed in a table, pasted from a
 * spreadsheet or read from a CSV file.
 */

export interface Row {
  id: string;
  name: string;
  number: string;
  qty: number;
}

export function newRow(p: Partial<Row> = {}): Row {
  return { id: "r" + Math.random().toString(36).slice(2, 9), name: "", number: "", qty: 1, ...p };
}

const NUMBER = /^#?\d{1,3}$/;
const HEADER = /^(namn|name|spelare|player|nummer|number|nr|no|antal|qty|quantity|st)$/i;

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

/** A pasted list or a CSV file. Header rows and blank lines are skipped. */
export function parseRoster(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((r): r is Row => r !== null && (r.name !== "" || r.number !== ""));
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

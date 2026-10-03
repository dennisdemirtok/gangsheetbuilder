import { measureTextAtHeight, renderTextAtHeight, type TextSpec } from "../utils/textRender";
import { buildPlacementsPayload, ensureGangSheet, prepareForCart, saveGangSheet, uploadImage } from "../services/api";
import { packSheet } from "../utils/packing";
import { EDGE_MARGIN_MM } from "../utils/layout";
import { priceKey, type Price, type PriceList } from "./pricing";
import { colorLabel, specFor, styleById, type Look } from "./catalog";
import type { Row } from "./roster";

/**
 * From a team list to a cart.
 *
 * Every name and number is a piece of its own: measured at the ordered
 * letter height, priced per piece by size, drawn at 300 DPI and laid out
 * on a gang sheet the print shop prints and cuts. The cart gets a line
 * for the names and one for the numbers, both pointing at that sheet.
 */

const SHEET_WIDTH_MM = 580;
const SHEET_MAX_MM = 10000;
const GAP_MM = 4;

export interface Graphic {
  key: string;
  kind: "name" | "number";
  text: string;
  spec: TextSpec;
  heightCm: number;
  count: number;
  widthMm: number;
  heightMm: number;
  price: Price | null;
  /** Wider than the film can print. */
  tooWide: boolean;
}

function nameText(row: Row, look: Look): string {
  return look.uppercase ? row.name.toLocaleUpperCase("sv-SE") : row.name;
}

/** The pieces a list needs, the same text and look counted once. */
export async function planGraphics(rows: Row[], look: Look, prices: PriceList): Promise<Graphic[]> {
  const byKey = new Map<string, Omit<Graphic, "widthMm" | "heightMm" | "price" | "tooWide">>();
  const add = (kind: Graphic["kind"], text: string, styleId: string, heightCm: number, qty: number) => {
    const key = `${kind}|${styleId}|${heightCm}|${text}`;
    const found = byKey.get(key);
    if (found) found.count += qty;
    else byKey.set(key, { key, kind, text, spec: specFor(text, styleId, look), heightCm, count: qty });
  };
  for (const row of rows) {
    const qty = Math.max(1, row.qty || 1);
    if (look.setup !== "numbers" && row.name.trim()) add("name", nameText(row, look), look.nameStyle, look.nameCm, qty);
    if (look.setup !== "names" && row.number.trim()) add("number", row.number.trim(), look.numberStyle, look.numberCm, qty);
  }

  const out: Graphic[] = [];
  for (const g of byKey.values()) {
    const size = await measureTextAtHeight(g.spec, g.heightCm * 10);
    if (!size) continue;
    out.push({
      ...g,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      price: prices.get(priceKey(g.kind, g.heightCm)) ?? null,
      tooWide: Math.min(size.widthMm, size.heightMm) > SHEET_WIDTH_MM - 2 * EDGE_MARGIN_MM,
    });
  }
  return out;
}

export interface Totals {
  pieces: number;
  subtotal: number;
  /** Pieces that cannot be ordered: wider than the film, or no price. */
  blocked: Graphic[];
}

export function totalsOf(graphics: Graphic[]): Totals {
  let pieces = 0;
  let subtotal = 0;
  const blocked: Graphic[] = [];
  for (const g of graphics) {
    pieces += g.count;
    if (g.price && !g.tooWide) subtotal += g.price.price * g.count;
    else blocked.push(g);
  }
  return { pieces, subtotal, blocked };
}

export interface OrderProgress {
  step: "draw" | "upload" | "sheet" | "cart";
  done: number;
  total: number;
}


function sessionId(): string {
  try {
    const key = "gs-nn-session";
    const found = sessionStorage.getItem(key);
    if (found) return found;
    const id = "nn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return "nn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

interface Uploaded {
  dbId: string;
  widthMm: number;
  heightMm: number;
  url: string;
}

/** Summary on the cart line: what the team ordered, in a few words. */
function describe(graphics: Graphic[], look: Look, rows: Row[]) {
  const names = graphics.filter((g) => g.kind === "name").reduce((n, g) => n + g.count, 0);
  const numbers = graphics.filter((g) => g.kind === "number").reduce((n, g) => n + g.count, 0);
  const style = [
    names ? `namn ${styleById(look.nameStyle).label.toLowerCase()} ${look.nameCm} cm` : "",
    numbers ? `nummer ${styleById(look.numberStyle).label.toLowerCase()} ${look.numberCm} cm` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const color = colorLabel(look.color) + (look.outline !== "none" ? `, ${colorLabel(look.outline).toLowerCase()} kontur` : "");
  const list = rows
    .filter((r) => r.name || r.number)
    .map((r) => [r.number, look.setup === "numbers" ? "" : r.name].filter(Boolean).join(" ") + (r.qty > 1 ? ` ×${r.qty}` : ""))
    .join(", ");
  return { style: style.charAt(0).toUpperCase() + style.slice(1), color, list: list.length > 240 ? list.slice(0, 237) + "…" : list };
}

/**
 * Draw, upload, lay out and add to the cart. A list too big for one 10 m
 * sheet continues on another; each sheet gets its own cart lines.
 */
export async function orderGraphics(
  graphics: Graphic[],
  look: Look,
  rows: Row[],
  onProgress: (p: OrderProgress) => void,
): Promise<void> {
  const priced = graphics.filter((g) => g.price && !g.tooWide);
  const session = sessionId();
  const copies = priced.flatMap((g) => Array.from({ length: g.count }, (_, i) => ({ g, id: `${g.key}#${i}` })));
  const totalUploads = priced.length;
  let uploadsDone = 0;

  const items: Array<{ id: string; quantity: number; properties: Record<string, string> }> = [];
  const summary = describe(priced, look, rows);
  let left = copies;
  let sheetNo = 0;

  while (left.length > 0) {
    sheetNo++;
    // Lay the remaining pieces out with their print sizes (known after the
    // first upload; measured sizes are within a pixel of them).
    const fit = packSheet(
      left.map((c) => ({ id: c.id, w: c.g.widthMm, h: c.g.heightMm, rotatable: true })),
      { widthMm: SHEET_WIDTH_MM, heightMm: SHEET_MAX_MM },
      GAP_MM,
    );
    const onSheet = left.filter((c) => fit.placements.has(c.id));
    if (onSheet.length === 0) throw new Error("Ett av trycken är bredare än filmen (58 cm). Välj en mindre storlek.");
    left = left.filter((c) => !fit.placements.has(c.id));

    onProgress({ step: "draw", done: uploadsDone, total: totalUploads });
    const gsId = await ensureGangSheet(session, SHEET_WIDTH_MM, 1000, "standard", null);

    // Draw and upload each distinct piece on this sheet, three at a time.
    const needed = [...new Set(onSheet.map((c) => c.g))];
    const uploaded = new Map<string, Uploaded>();
    const queue = [...needed];
    const worker = async () => {
      while (queue.length > 0) {
        const g = queue.shift()!;
        const drawn = await renderTextAtHeight(g.spec, g.heightCm * 10);
        if (!drawn) throw new Error(`Kunde inte rita "${g.text}"`);
        const blob: Blob | null = await new Promise((r) => drawn.canvas.toBlob(r, "image/png"));
        if (!blob) throw new Error(`Kunde inte spara "${g.text}"`);
        onProgress({ step: "upload", done: uploadsDone, total: totalUploads });
        const file = new File([blob], `${g.kind === "name" ? "namn" : "nummer"}-${g.text.replace(/[^\wåäöÅÄÖ-]+/g, "_").slice(0, 24) || "x"}.png`, { type: "image/png" });
        const result = await uploadImage(file, session, gsId);
        uploaded.set(g.key, {
          dbId: result.id,
          widthMm: result.width * drawn.mmPerPx,
          heightMm: result.height * drawn.mmPerPx,
          url: result.thumbnailUrl,
        });
        uploadsDone++;
        onProgress({ step: "upload", done: uploadsDone, total: totalUploads });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, needed.length) }, worker));

    // Lay out again with the exact uploaded sizes.
    onProgress({ step: "sheet", done: uploadsDone, total: totalUploads });
    const exact = packSheet(
      onSheet.map((c) => {
        const u = uploaded.get(c.g.key)!;
        return { id: c.id, w: u.widthMm, h: u.heightMm, rotatable: true };
      }),
      { widthMm: SHEET_WIDTH_MM, heightMm: SHEET_MAX_MM },
      GAP_MM,
    );
    const placed = onSheet.filter((c) => exact.placements.has(c.id));
    // Anything the exact sizes pushed off this sheet goes on the next one.
    left = [...onSheet.filter((c) => !exact.placements.has(c.id)), ...left];
    const heightMm = Math.min(SHEET_MAX_MM, Math.ceil((exact.bottomMm + EDGE_MARGIN_MM) / 100) * 100);

    const images = placed.map((c) => {
      const u = uploaded.get(c.g.key)!;
      const p = exact.placements.get(c.id)!;
      return {
        id: c.id,
        dbId: u.dbId,
        positionX: p.x,
        positionY: p.y,
        displayWidth: u.widthMm,
        displayHeight: u.heightMm,
        rotation: p.rotated ? 90 : 0,
        flipX: false,
        flipY: false,
        marginMm: GAP_MM,
        bgRemovedUrl: undefined,
      };
    });
    await saveGangSheet(gsId, buildPlacementsPayload(images as any, { widthMm: SHEET_WIDTH_MM, heightMm }, "standard"));
    const cartData = await prepareForCart(gsId, null);

    // A cart line for the names and one for the numbers on this sheet.
    onProgress({ step: "cart", done: uploadsDone, total: totalUploads });
    const groups = new Map<string, { price: Price; count: number }>();
    for (const c of placed) {
      const key = c.g.price!.variantId;
      const found = groups.get(key);
      if (found) found.count++;
      else groups.set(key, { price: c.g.price!, count: 1 });
    }
    let first = true;
    for (const group of groups.values()) {
      items.push({
        id: group.price.variantId,
        quantity: group.count,
        properties: {
          Stil: summary.style,
          Färg: summary.color,
          ...(first ? { Lista: summary.list } : {}),
          ...(sheetNo > 1 ? { Ark: String(sheetNo) } : {}),
          ...cartData.properties,
          _gang_sheet_id: gsId,
          // The sheet holds every piece once: the line quantity is pieces, not copies.
          _nn: "1",
        },
      });
      first = false;
    }
  }

  const root = (window as any).Shopify?.routes?.root || "/";
  const res = await fetch(`${root}cart/add.js`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("Varukorgen svarade inte. Försök igen om en stund.");
}

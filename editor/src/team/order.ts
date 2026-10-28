import { buildPlacementsPayload, ensureGangSheet, prepareForCart, saveGangSheet, uploadImage } from "../services/api";
import { packSheet } from "../utils/packing";
import { EDGE_MARGIN_MM } from "../utils/layout";
import type { Price } from "./data";

/**
 * From a team package to a cart.
 *
 * The shirts, the stock digits and the press are ordinary cart lines. The
 * logos, club and sponsors, go on one gang sheet the print shop prints once
 * and cuts up, the way Namn och Siffror does it (`_nn`): one cart line per
 * logo, all pointing at that sheet, quantity = pieces.
 */

const SHEET_WIDTH_MM = 580;
const SHEET_MAX_MM = 10000;
const GAP_MM = 4;

/** A logo for the sheet: the club's or the customer's file, printed this wide. */
export interface Piece {
  key: string;
  /** For the cart line: "Sundsvalls HK", "Sponsor 1". */
  label: string;
  count: number;
  price: Price;
  /** Cart line properties shown to the customer and the print shop. */
  properties: Record<string, string>;
  file: () => Promise<File>;
  widthCm: number;
}

/** A line that is not printed: a shirt, a stock digit, the press. */
export interface CartLine {
  variantId: string;
  quantity: number;
  properties?: Record<string, string>;
}

export interface OrderProgress {
  step: "draw" | "upload" | "sheet" | "cart";
  done: number;
  total: number;
}

function sessionId(): string {
  const fresh = () => "team_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const key = "gs-team-session";
    const found = sessionStorage.getItem(key);
    if (found) return found;
    const id = fresh();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return fresh();
  }
}

/** A club logo saved in Shopify, fetched so it can go on the sheet like an upload. */
export async function fileFromUrl(url: string, name: string): Promise<File> {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Kunde inte hämta loggan för ${name}`);
  const blob = await res.blob();
  const ext = /png/.test(blob.type) ? "png" : /svg/.test(blob.type) ? "svg" : "jpg";
  return new File([blob], `${name.replace(/[^\wåäöÅÄÖ-]+/g, "_").slice(0, 32) || "logga"}.${ext}`, { type: blob.type || "image/png" });
}

interface Uploaded {
  dbId: string;
  widthMm: number;
  heightMm: number;
}

/**
 * Fetch each logo once, upload it, lay every copy out on one sheet and put
 * the plain lines and the logo lines in the cart.
 */
export async function orderTeam(
  pieces: Piece[],
  plain: CartLine[],
  onProgress: (p: OrderProgress) => void,
): Promise<void> {
  const printed = pieces.filter((p) => p.count > 0);
  const items: Array<{ id: string; quantity: number; properties?: Record<string, string> }> = plain
    .filter((l) => l.quantity > 0)
    .map((l) => ({ id: l.variantId, quantity: l.quantity, ...(l.properties ? { properties: l.properties } : {}) }));

  if (printed.length > 0) {
    const session = sessionId();
    onProgress({ step: "draw", done: 0, total: printed.length });
    const gsId = await ensureGangSheet(session, SHEET_WIDTH_MM, 1000, "standard", null);

    const uploaded = new Map<string, Uploaded>();
    const queue = [...printed];
    let done = 0;
    const worker = async () => {
      while (queue.length > 0) {
        const piece = queue.shift()!;
        const file = await piece.file();
        onProgress({ step: "upload", done, total: printed.length });
        const result = await uploadImage(file, session, gsId);
        const w = Number(result.width) || 1;
        const h = Number(result.height) || 1;
        // A logo is ordered by width; the server trims empty edges, so the
        // width is applied to what it kept.
        const perPx = (piece.widthCm * 10) / w;
        uploaded.set(piece.key, { dbId: String(result.id), widthMm: w * perPx, heightMm: h * perPx });
        done++;
        onProgress({ step: "upload", done, total: printed.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, printed.length) }, worker));

    onProgress({ step: "sheet", done, total: printed.length });
    const copies = printed.flatMap((p) => Array.from({ length: p.count }, (_, i) => ({ p, id: `${p.key}#${i}` })));
    const fit = packSheet(
      copies.map((c) => {
        const u = uploaded.get(c.p.key)!;
        return { id: c.id, w: u.widthMm, h: u.heightMm, rotatable: true };
      }),
      { widthMm: SHEET_WIDTH_MM, heightMm: SHEET_MAX_MM },
      GAP_MM,
    );
    if (fit.placements.size < copies.length) {
      throw new Error("Allt får inte plats på ett ark (10 m). Dela upp beställningen i två.");
    }
    const heightMm = Math.min(SHEET_MAX_MM, Math.ceil((fit.bottomMm + EDGE_MARGIN_MM) / 100) * 100);
    const images = copies.map((c) => {
      const u = uploaded.get(c.p.key)!;
      const at = fit.placements.get(c.id)!;
      return {
        id: c.id,
        dbId: u.dbId,
        positionX: at.x,
        positionY: at.y,
        displayWidth: u.widthMm,
        displayHeight: u.heightMm,
        rotation: at.rotated ? 90 : 0,
        flipX: false,
        flipY: false,
        marginMm: GAP_MM,
        bgRemovedUrl: undefined,
      };
    });
    await saveGangSheet(gsId, buildPlacementsPayload(images as any, { widthMm: SHEET_WIDTH_MM, heightMm }, "standard"));
    const cartData = await prepareForCart(gsId, null);

    onProgress({ step: "cart", done, total: printed.length });
    // Each logo on a line of its own, so the cart says which is which.
    for (const p of printed) {
      items.push({
        id: p.price.variantId,
        quantity: p.count,
        properties: { ...p.properties, ...cartData.properties, _gang_sheet_id: gsId, _nn: "1" },
      });
    }
  }

  onProgress({ step: "cart", done: 0, total: 0 });
  const root = (window as any).Shopify?.routes?.root || "/";
  const res = await fetch(`${root}cart/add.js`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    let message = "Varukorgen svarade inte. Försök igen om en stund.";
    try {
      const body = await res.json();
      if (body?.description) message = String(body.description);
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
}

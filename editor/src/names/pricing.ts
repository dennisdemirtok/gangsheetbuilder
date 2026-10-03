/**
 * Prices come from the product's own variants, rendered by the theme:
 * "Namn 7 cm", "Nummer 25 cm" … one price per piece and size, the way team
 * numbers are sold, so the cart says "Nummer 25 cm × 15" rather than a
 * line per area step, and B2B catalogue prices apply without the app
 * knowing. Volume discounts are Shopify automatic discounts (the same
 * steps as By Size); the steps here only show what they give.
 */

export interface Price {
  variantId: string;
  price: number;
}

export type PriceList = Map<string, Price>;

export function priceKey(kind: "name" | "number", cm: number): string {
  return `${kind}:${cm}`;
}

export function readPrices(json: unknown): PriceList {
  const list = Array.isArray(json) ? json : [];
  const out: PriceList = new Map();
  for (const v of list as any[]) {
    const m = /^(namn|nummer)\s+(\d+)\s*cm/i.exec(String(v.title ?? "").trim());
    if (!m) continue;
    const kind = m[1]!.toLowerCase() === "namn" ? "name" : "number";
    out.set(priceKey(kind, parseInt(m[2]!, 10)), { variantId: String(v.id), price: Number(v.price_cents ?? 0) / 100 });
  }
  return out;
}

export const TIERS = [
  { min: 15, pct: 20 },
  { min: 50, pct: 30 },
  { min: 100, pct: 40 },
  { min: 250, pct: 50 },
];

export function tierFor(count: number): { min: number; pct: number } | null {
  return [...TIERS].reverse().find((t) => count >= t.min) ?? null;
}

export function nextTier(count: number): { min: number; pct: number } | null {
  return TIERS.find((t) => count < t.min) ?? null;
}

export function kr(n: number): string {
  return `${n.toLocaleString("sv-SE", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} kr`;
}

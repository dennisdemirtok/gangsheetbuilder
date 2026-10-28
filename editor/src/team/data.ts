/**
 * What the team page's block hands the builder, rendered by the theme so
 * Shopify prices it for whoever is looking (B2B catalogues included):
 *
 * - the shirt product's variants (colour × size),
 * - the stock digits, product "Lagsiffror": style and height, colour and
 *   figure as its three options ("Arena 20 cm" / "Vit" / "7"), one price
 *   per figure; they ship from the shop's own stock, not the print shop,
 * - the price product's variants for logos, "Logga 8 cm" …, one price per
 *   piece,
 * - the partner clubs, metaobjects of type "forening" with a saved logo,
 * - the heat press recommended alongside, if one is chosen.
 */

export interface ShirtVariant {
  id: string;
  color: string;
  size: string;
  price: number;
  available: boolean;
  /** Small front packshot for the step's thumbnail. */
  image: string | null;
  /** Packshots the preview prints on, front and back. */
  front: string | null;
  back: string | null;
}

export interface Shirt {
  title: string;
  vendor: string;
  url: string | null;
  variants: ShirtVariant[];
}

/** The press the page recommends to a club that presses its own shirts. */
export interface Press {
  variantId: string;
  title: string;
  vendor: string;
  price: number;
  image: string | null;
  url: string | null;
}

export interface Club {
  id: string;
  name: string;
  city: string;
  sport: string;
  logo: string | null;
  widthCm: number;
}

export interface Price {
  variantId: string;
  price: number;
}

/** "logo:8" … */
export type PriceList = Map<string, Price>;

/** A stock figure: digitStockKey(style, height, colour, figure) → variant. */
export type DigitStock = Map<string, Price>;

/** Figures are stocked in white and black only. */
export const DIGIT_INKS = [
  { value: "#ffffff", label: "Vit" },
  { value: "#111111", label: "Svart" },
];

export function digitStockKey(style: string, heightCm: number, color: string, digit: number): string {
  return `${style.toLowerCase()}|${heightCm}|${color.toLowerCase()}|${digit}`;
}

export interface TeamData {
  shirt: Shirt | null;
  prices: PriceList;
  digits: DigitStock;
  clubs: Club[];
  press: Press | null;
}

export const DIGIT_HEIGHTS_CM = [20, 25];
/** Logo widths sold, each the most a logo at that price may measure. */
export const LOGO_WIDTHS_CM = [8, 15, 25];

/** The price step a logo of this width falls in. */
export function logoKey(widthCm: number): string {
  const step = LOGO_WIDTHS_CM.find((w) => widthCm <= w + 0.01) ?? LOGO_WIDTHS_CM[LOGO_WIDTHS_CM.length - 1]!;
  return `logo:${step}`;
}

const num = (v: unknown, fallback = 0) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

export function readTeamData(json: unknown): TeamData {
  const raw = (json && typeof json === "object" ? json : {}) as Record<string, any>;

  const prices: PriceList = new Map();
  for (const v of Array.isArray(raw.prices) ? raw.prices : []) {
    const m = /^logga\s+(\d+)\s*cm/i.exec(String(v?.title ?? "").trim());
    if (!m) continue;
    prices.set(`logo:${parseInt(m[1]!, 10)}`, { variantId: String(v.id), price: num(v.price_cents) / 100 });
  }

  const digits: DigitStock = new Map();
  for (const v of Array.isArray(raw.digits) ? raw.digits : []) {
    const m = /^(.+?)\s+(\d+)\s*cm$/i.exec(String(v?.style ?? "").trim());
    const figure = parseInt(String(v?.digit ?? ""), 10);
    if (!m || !(figure >= 0 && figure <= 9) || !v?.color) continue;
    digits.set(digitStockKey(m[1]!, parseInt(m[2]!, 10), String(v.color), figure), { variantId: String(v.id), price: num(v.price_cents) / 100 });
  }

  const s = raw.shirt;
  const shirt: Shirt | null =
    s && Array.isArray(s.variants) && s.variants.length
      ? {
          title: String(s.title ?? ""),
          vendor: String(s.vendor ?? ""),
          url: s.url ? String(s.url) : null,
          variants: s.variants.map((v: any) => ({
            id: String(v.id),
            color: String(v.color ?? ""),
            size: String(v.size ?? ""),
            price: num(v.price_cents) / 100,
            available: v.available !== false,
            image: v.image ? String(v.image) : null,
            front: v.front ? String(v.front) : null,
            back: v.back ? String(v.back) : null,
          })),
        }
      : null;

  const clubs: Club[] = (Array.isArray(raw.clubs) ? raw.clubs : [])
    .filter((c: any) => c && c.name)
    .map((c: any) => ({
      id: String(c.id ?? c.name),
      name: String(c.name),
      city: String(c.city ?? ""),
      sport: String(c.sport ?? ""),
      logo: c.logo ? String(c.logo) : null,
      widthCm: num(c.widthCm, 6) || 6,
    }))
    .sort((a: Club, b: Club) => a.name.localeCompare(b.name, "sv"));

  const p = raw.press;
  const press: Press | null =
    p && p.variantId
      ? {
          variantId: String(p.variantId),
          title: String(p.title ?? ""),
          vendor: String(p.vendor ?? ""),
          price: num(p.price_cents) / 100,
          image: p.image ? String(p.image) : null,
          url: p.url ? String(p.url) : null,
        }
      : null;

  return { shirt, prices, digits, clubs, press };
}

/** Garment measurements (cm) for the preview: half chest and body length. */
export const SIZE_CHART: Record<string, { chest: number; length: number }> = {
  "110/120": { chest: 35, length: 47 },
  "130/140": { chest: 39, length: 53 },
  "150/160": { chest: 44, length: 59 },
};

export function kr(n: number): string {
  return `${n.toLocaleString("sv-SE", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} kr`;
}

/** Every digit the numbers need, 0-9: 1-15 needs eight ones. */
export function countDigits(numbers: string[]): number[] {
  const out = Array(10).fill(0) as number[];
  for (const n of numbers) for (const ch of n) if (ch >= "0" && ch <= "9") out[+ch]!++;
  return out;
}

/** "1, 4, 7, 10" or one per line; anything up to two digits. */
export function parseNumbers(text: string): string[] {
  return text
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((s) => String(parseInt(s, 10)))
    .filter((s) => s.length <= 2);
}

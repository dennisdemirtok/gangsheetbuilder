/**
 * Prices and variant ids as Shopify itself renders them.
 *
 * The editor used to display a price computed from the app's own config
 * table while the cart charged whatever the mapped variant cost — two
 * independent numbers that could disagree, and did. The theme block emits
 * the real variants instead, priced by Shopify for whoever is logged in,
 * so a B2B contact on a company catalog sees their negotiated rate with no
 * catalog logic in the app at all.
 */

export interface SheetVariant {
  /** Sheet size key, e.g. "58x100". Null for the per-decimetre variant. */
  sizeKey: string | null;
  /** Numeric Shopify variant id for cart/add.js. */
  variantId: string;
  /** Price in the shop's currency, already contextual to the buyer. */
  priceSek: number;
  title: string;
  available: boolean;
}

let cached: Record<string, SheetVariant> | null = null;

/**
 * Read the table the theme block rendered. Returns an empty map when the
 * block is missing or points at a product without per-length variants —
 * callers must cope, because a wrong price is worse than no price.
 */
export function getSheetVariants(): Record<string, SheetVariant> {
  if (cached) return cached;

  const out: Record<string, SheetVariant> = {};
  try {
    const el = document.getElementById("gangsheet-variant-data");
    if (!el?.textContent) return out;

    const raw = JSON.parse(el.textContent) as Record<string, unknown>;
    for (const [handle, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object") continue;
      const v = entry as Record<string, unknown>;
      const cents = typeof v.price_cents === "number" ? v.price_cents : null;
      if (cents === null || v.id === undefined) continue;

      const sizeKey = typeof v.size_key === "string" ? v.size_key : null;
      /*
       * Keyed by sheet size when there is one, otherwise by the variant
       * handle. Dropping size-less variants used to discard the
       * per-decimetre one, and the ready-sheet flow then fell back to the
       * whole-metre variant while still passing a quantity in decimetres —
       * ten times the price it had just shown the customer.
       */
      out[sizeKey ?? handle] = {
        sizeKey,
        variantId: String(v.id),
        priceSek: cents / 100,
        title: typeof v.title === "string" ? v.title : handle,
        available: v.available !== false,
      };
    }
  } catch (err) {
    console.error("[GS] Could not read variant prices from the theme:", err);
  }

  cached = out;
  return out;
}

/**
 * The variant a ready sheet is billed with: one unit per decimetre, so a
 * file is charged for the length it actually uses. Both the displayed
 * price and the cart line must come from this one object — deriving the
 * price from one variant and billing another is how they drift apart.
 */
export function getPerDecimeterVariant(): SheetVariant | null {
  return (
    Object.values(getSheetVariants()).find(
      (v) => v.sizeKey === null && /decimeter|dm/i.test(v.title),
    ) ?? null
  );
}

/** Decimetres in a sheet key like "58x150" (→ 15), or null. */
function decimetresOf(sizeKey: string): number | null {
  const m = /^58x(\d+)$/.exec(sizeKey);
  return m ? Math.round(Number(m[1]) / 10) : null;
}

/**
 * Price for one sheet of this size, or null when the theme did not supply
 * one. Whole metres have their own variant; any other length is that many
 * decimetres of the per-decimetre variant.
 */
export function getSheetPrice(sizeKey: string): number | null {
  const v = getSheetVariants()[sizeKey];
  if (v && v.sizeKey) return v.priceSek;
  const dm = decimetresOf(sizeKey);
  const perDm = getPerDecimeterVariant();
  return dm && perDm ? dm * perDm.priceSek : null;
}

/** Variant to put in the cart for this sheet size (whole metres only). */
export function getSheetVariantId(sizeKey: string): string | null {
  const v = getSheetVariants()[sizeKey];
  return v && v.sizeKey ? v.variantId : null;
}

/**
 * The cart line for `copies` sheets of this size. Whole metres keep their
 * own variant, as before. Other lengths are billed as decimetres of the
 * per-decimetre variant — the quantity is decimetres × copies, so the
 * line carries both, for the order to read back how many sheets it is.
 */
export function getSheetCartLine(
  sizeKey: string,
  copies: number,
): { variantId: string; quantity: number; properties: Record<string, string> } | null {
  const n = Math.max(1, Math.floor(copies || 1));
  const whole = getSheetVariantId(sizeKey);
  const dm = decimetresOf(sizeKey);
  const lengthText = dm ? `${(dm / 10).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} m` : sizeKey;
  if (whole) {
    return { variantId: whole, quantity: n, properties: n > 1 ? { "Antal ark": String(n) } : {} };
  }
  const perDm = getPerDecimeterVariant();
  if (!perDm || !dm) return null;
  return {
    variantId: perDm.variantId,
    quantity: dm * n,
    properties: { Längd: lengthText, "Antal ark": String(n), _decimeters: String(dm) },
  };
}

/** True when the theme gave us a usable price table. */
export function hasStorefrontPrices(): boolean {
  return Object.keys(getSheetVariants()).length > 0;
}

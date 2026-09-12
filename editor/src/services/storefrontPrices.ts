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
  /** Sheet size key, e.g. "58x100". */
  sizeKey: string;
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
    for (const entry of Object.values(raw)) {
      if (!entry || typeof entry !== "object") continue;
      const v = entry as Record<string, unknown>;
      const sizeKey = typeof v.size_key === "string" ? v.size_key : null;
      const cents = typeof v.price_cents === "number" ? v.price_cents : null;
      if (!sizeKey || cents === null || v.id === undefined) continue;

      out[sizeKey] = {
        sizeKey,
        variantId: String(v.id),
        priceSek: cents / 100,
        title: typeof v.title === "string" ? v.title : sizeKey,
        available: v.available !== false,
      };
    }
  } catch (err) {
    console.error("[GS] Could not read variant prices from the theme:", err);
  }

  cached = out;
  return out;
}

/** Price for one sheet of this size, or null when the theme did not supply one. */
export function getSheetPrice(sizeKey: string): number | null {
  return getSheetVariants()[sizeKey]?.priceSek ?? null;
}

/** Variant to put in the cart for this sheet size. */
export function getSheetVariantId(sizeKey: string): string | null {
  return getSheetVariants()[sizeKey]?.variantId ?? null;
}

/** True when the theme gave us a usable price table. */
export function hasStorefrontPrices(): boolean {
  return Object.keys(getSheetVariants()).length > 0;
}

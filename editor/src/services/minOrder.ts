import { useEffect, useState } from "react";
import { minOrderKr } from "./shopSettings";
import { getSheetPrice } from "./storefrontPrices";
import { MAX_SHEET_MM, SHEET_STEP_MM, sheetForHeight } from "../config/sheets";

/**
 * The cart's minimum order, told in the builder.
 *
 * The theme turns the checkout button off below the minimum (300 kr), and
 * the builder never said so: a 1 m sheet costs 200 kr, the customer put it
 * in the cart, read "Ditt ark är redo för kassan" and then found checkout
 * shut. 43 % of such carts were left (20 Oct – 19 Nov 2026), against 24 % of
 * carts over the minimum. Business accounts have no minimum and see nothing.
 */

const root = () => document.getElementById("gangsheet-editor-root");

/** A logged-in business customer: the cart lets them order without a minimum. */
export function isBusinessCustomer(): boolean {
  return root()?.dataset.b2b === "true";
}

/**
 * Kronor already in the cart, leaving out the lines of these sheets (the
 * builder replaces them when they are added again). Null when the cart
 * cannot be read.
 */
async function cartTotalExcept(sheetIds: string[]): Promise<number | null> {
  const ours = new Set(sheetIds.filter(Boolean));
  try {
    const shopRoot = (window as any).Shopify?.routes?.root || "/";
    const cart = await fetch(`${shopRoot}cart.js`).then((response) => response.json());
    let cents = 0;
    for (const item of cart.items || []) {
      const props = item.properties || {};
      if (ours.has(props._gang_sheet_id) || ours.has(props._sheet_id)) continue;
      cents += Number(item.final_line_price) || 0;
    }
    return cents / 100;
  } catch {
    return null;
  }
}

/**
 * What else is in the cart, read when the builder opens and again when the
 * customer comes back to the tab (they may have shopped in another one).
 */
export function useCartTotalExcept(sheetIds: string[]): number {
  const key = sheetIds.filter(Boolean).sort().join(",");
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void cartTotalExcept(key ? key.split(",") : []).then((kr) => {
        if (alive && kr !== null) setTotal(kr);
      });
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);
  return total;
}

export interface Shortfall {
  /** The minimum order, kr. */
  min: number;
  /** What is still missing, kr. */
  missing: number;
  /** Already in the cart besides these sheets, kr. */
  inCart: number;
}

/** How far the order is below the minimum, or null when it is not (or no minimum applies). */
export function shortfallFor(sheetsTotal: number | null, inCart: number): Shortfall | null {
  const min = minOrderKr();
  if (min === null || sheetsTotal === null || isBusinessCustomer()) return null;
  const missing = Math.ceil(min - sheetsTotal - inCart);
  return missing > 0 ? { min, missing, inCart } : null;
}

/** The shortest sheet, from this length up, that reaches the minimum on its own with the cart. */
export function lengthThatReaches(heightMm: number, inCart: number): { heightMm: number; price: number } | null {
  const min = minOrderKr();
  if (min === null) return null;
  for (let h = heightMm + SHEET_STEP_MM; h <= MAX_SHEET_MM; h += SHEET_STEP_MM) {
    const size = sheetForHeight(h);
    const price = getSheetPrice(size.key);
    if (price === null) return null;
    if (price + inCart >= min) return { heightMm: size.heightMm, price };
  }
  return null;
}

/** "1,5 m". */
export function metres(heightMm: number): string {
  return `${(heightMm / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} m`;
}

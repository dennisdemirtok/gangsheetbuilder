/**
 * Shop rules the theme block passes on the editor's root element, so a
 * text that states them follows the shop instead of the code.
 */

const root = () => document.getElementById("gangsheet-editor-root");

/** The smallest order value in kronor, or null when the block does not say. */
export function minOrderKr(): number | null {
  const n = Number(root()?.dataset.minOrder);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Where a business customer applies for an account: no minimum order. */
export const BUSINESS_ACCOUNT_URL = "/a/foretagskonto";

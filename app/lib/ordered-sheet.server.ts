import { json } from "@remix-run/node";

/**
 * A sheet that belongs to an order is the customer's paid print job. The
 * storefront must never change it: a builder still holding its id (an old
 * bundle, "Redigera arket" after checkout, a cart that could not be read)
 * used to save over it, and the print shop then got a sheet nobody paid for.
 *
 * The order webhook sets shopifyOrderId (order-intake.server.ts). Any status
 * past "pending" also means the print pipeline has it: exports are only ever
 * queued for ordered sheets.
 */
export function isOrderedSheet(sheet: { shopifyOrderId: string | null; status: string }): boolean {
  return sheet.shopifyOrderId !== null || (sheet.status !== "draft" && sheet.status !== "pending");
}

/** The code the builder looks for to put a new sheet in the cart instead. */
export const SHEET_ORDERED = "sheet_ordered";

/**
 * The refusal. The builder answers it by creating a new sheet; an older
 * builder shows `error` to the customer.
 */
export function orderedSheetRefusal(gangSheetId: string, route: string) {
  console.warn(`[${route}] refused: gang sheet ${gangSheetId} already belongs to an order`);
  return json(
    {
      error: "Det här arket är redan beställt och kan inte ändras. Ladda om sidan och lägg motiven på ett nytt ark.",
      code: SHEET_ORDERED,
    },
    { status: 409 },
  );
}

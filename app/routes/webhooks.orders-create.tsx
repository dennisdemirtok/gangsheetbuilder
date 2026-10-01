import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { intakeOrder, isInvoiceOrder, type WebhookOrder } from "../lib/order-intake.server";

/**
 * New orders. Card orders wait for orders/paid; B2B orders on invoice are
 * never paid at this point — whether created by hand in the admin or at
 * checkout — so they enter the print queue as soon as they exist.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  if (isInvoiceOrder(payload as WebhookOrder)) {
    await intakeOrder(shop, payload, admin);
  }
  return new Response(null, { status: 200 });
};

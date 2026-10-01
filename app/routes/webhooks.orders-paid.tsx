import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { intakeOrder } from "../lib/order-intake.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  await intakeOrder(shop, payload, admin);
  return new Response(null, { status: 200 });
};

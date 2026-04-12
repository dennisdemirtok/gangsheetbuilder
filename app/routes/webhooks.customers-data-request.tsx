import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  // GDPR: respond to customer data request
  // In production, export the customer's gang sheet data
  return new Response(null, { status: 200 });
};

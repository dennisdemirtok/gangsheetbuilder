import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  // GDPR: shop data redaction
  // Delete all app data for this shop
  return new Response(null, { status: 200 });
};

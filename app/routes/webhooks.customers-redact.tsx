import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deletePrefix } from "../lib/r2.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);

  const data = payload as {
    customer: { id: number };
    orders_to_redact: number[];
  };

  // Delete gang sheets associated with the redacted orders
  for (const orderId of data.orders_to_redact) {
    const gangSheets = await prisma.gangSheet.findMany({
      where: { shopifyOrderId: String(orderId) },
    });

    for (const gs of gangSheets) {
      // Delete files from R2
      await deletePrefix(`uploads/${gs.sessionId}/`);
      await deletePrefix(`exports/${gs.id}/`);

      // Delete from database (cascade deletes images and exports)
      await prisma.gangSheet.delete({ where: { id: gs.id } });
    }
  }

  return new Response(null, { status: 200 });
};

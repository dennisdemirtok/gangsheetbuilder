import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getExportQueue, type ExportJobData } from "../lib/queue.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const order = payload as {
    id: number;
    line_items: Array<{
      id: number;
      properties: Array<{ name: string; value: string }>;
    }>;
  };

  // Find line items with gang sheet metadata. Each line item is handled
  // independently so one bad ID can't 500 the whole webhook (Shopify would
  // retry-storm on non-200 responses).
  for (const lineItem of order.line_items || []) {
    try {
      const gangSheetIdProp = lineItem.properties?.find(
        (p) => p.name === "_gang_sheet_id",
      );

      if (!gangSheetIdProp) continue;

      const gangSheetId = gangSheetIdProp.value;

      // Verify the gang sheet exists and belongs to this shop
      const gangSheet = await prisma.gangSheet.findUnique({
        where: { id: gangSheetId },
        select: { id: true, shopDomain: true },
      });

      if (!gangSheet) {
        console.warn(
          `[orders-paid] Gang sheet ${gangSheetId} not found (order ${order.id}, shop ${shop})`,
        );
        continue;
      }

      if (gangSheet.shopDomain !== shop) {
        console.warn(
          `[orders-paid] Gang sheet ${gangSheetId} belongs to ${gangSheet.shopDomain}, not ${shop} — skipping`,
        );
        continue;
      }

      // Update gang sheet with order info
      await prisma.gangSheet.update({
        where: { id: gangSheetId },
        data: {
          shopifyOrderId: String(order.id),
          shopifyLineItemId: String(lineItem.id),
          status: "pending",
        },
      });

      // Enqueue export job with a deterministic jobId so BullMQ dedupes
      // webhook redeliveries.
      const exportQueue = getExportQueue();
      const jobData: ExportJobData = {
        gangSheetId,
        shopDomain: shop,
      };
      await exportQueue.add(`export-${gangSheetId}`, jobData, {
        jobId: `export-${gangSheetId}-${order.id}`,
      });
    } catch (error) {
      console.error(
        `[orders-paid] Failed to process line item ${lineItem?.id} of order ${order.id}:`,
        error,
      );
    }
  }

  return new Response(null, { status: 200 });
};

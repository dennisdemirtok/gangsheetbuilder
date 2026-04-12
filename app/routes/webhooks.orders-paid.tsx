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

  // Find line items with gang sheet metadata
  for (const lineItem of order.line_items) {
    const gangSheetIdProp = lineItem.properties?.find(
      (p) => p.name === "_gang_sheet_id",
    );

    if (!gangSheetIdProp) continue;

    const gangSheetId = gangSheetIdProp.value;

    // Update gang sheet with order info
    await prisma.gangSheet.update({
      where: { id: gangSheetId },
      data: {
        shopifyOrderId: String(order.id),
        shopifyLineItemId: String(lineItem.id),
        status: "pending",
      },
    });

    // Enqueue export job
    const exportQueue = getExportQueue();
    const jobData: ExportJobData = {
      gangSheetId,
      shopDomain: shop,
    };
    await exportQueue.add(`export-${gangSheetId}`, jobData);
  }

  return new Response(null, { status: 200 });
};

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getExportQueue, type ExportJobData } from "../lib/queue.server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  interface WebhookAddress {
    name?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    zip?: string | null;
    city?: string | null;
    country?: string | null;
    country_code?: string | null;
    phone?: string | null;
  }

  const order = payload as {
    id: number;
    name?: string;
    email?: string | null;
    phone?: string | null;
    customer?: { first_name?: string | null; last_name?: string | null } | null;
    shipping_address?: WebhookAddress | null;
    billing_address?: WebhookAddress | null;
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

      /*
       * Copy what the print shop needs onto the sheet.
       *
       * The app only stored the numeric order id, so its order list showed
       * "#13513260728694" and the detail page had no recipient at all — the
       * shop could print a sheet but had no way to post it without going
       * back to Shopify to look the customer up.
       */
      const ship = order.shipping_address || order.billing_address || null;
      const customerName =
        ship?.name ||
        [order.customer?.first_name, order.customer?.last_name]
          .filter(Boolean)
          .join(" ") ||
        null;

      await prisma.gangSheet.update({
        where: { id: gangSheetId },
        data: {
          shopifyOrderId: String(order.id),
          shopifyLineItemId: String(lineItem.id),
          orderName: order.name ? String(order.name) : null,
          customerName,
          shippingAddress: ship
            ? {
                name: ship.name ?? null,
                company: ship.company ?? null,
                address1: ship.address1 ?? null,
                address2: ship.address2 ?? null,
                zip: ship.zip ?? null,
                city: ship.city ?? null,
                country: ship.country ?? null,
                countryCode: ship.country_code ?? null,
                phone: ship.phone ?? order.phone ?? null,
                email: order.email ?? null,
              }
            : Prisma.DbNull,
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

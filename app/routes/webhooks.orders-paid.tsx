import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getExportQueue, type ExportJobData } from "../lib/queue.server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { bookOrderShipment } from "../lib/order-shipment.server";

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
      title?: string;
      variant_title?: string | null;
      quantity?: number;
      requires_shipping?: boolean;
      properties: Array<{ name: string; value: string }>;
    }>;
  };

  /*
   * The BWS pickup in Poland is for DTF transfers only. Transfer presses and
   * blanks on the same order ship some other way, so remember them: the
   * admin warns about them and auto-booking leaves mixed orders alone.
   */
  const otherLineItems = (order.line_items || [])
    .filter(
      (li) =>
        li.requires_shipping !== false &&
        !li.properties?.some((p) => p.name === "_gang_sheet_id"),
    )
    .map((li) => ({
      title: [li.title, li.variant_title].filter(Boolean).join(" – "),
      quantity: li.quantity ?? 1,
    }));

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
          otherLineItems: otherLineItems.length > 0 ? otherLineItems : Prisma.DbNull,
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

  /*
   * Optional: book the BWS pickup and label the moment the order is paid.
   * Off unless BWS_AUTO_BOOK=true — every booking sends a real courier to
   * the print shop. Not awaited, so Shopify gets its 200 within its timeout;
   * bookOrderShipment claims the order first, so a redelivery cannot book
   * twice. Orders that also hold presses or blanks are booked by hand.
   */
  if (process.env.BWS_AUTO_BOOK === "true" && otherLineItems.length === 0) {
    const linked = await prisma.gangSheet.count({
      where: { shopDomain: shop, shopifyOrderId: String(order.id) },
    });
    if (linked > 0) {
      void bookOrderShipment({
        shopDomain: shop,
        shopifyOrderId: String(order.id),
      }).catch((error) =>
        console.error(`[orders-paid] BWS auto-booking failed for ${order.id}:`, error),
      );
    }
  }

  return new Response(null, { status: 200 });
};

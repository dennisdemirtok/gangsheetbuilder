import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getExportQueue, type ExportJobData } from "../lib/queue.server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { bookOrderShipment } from "../lib/order-shipment.server";
import {
  DEFAULT_PRINT_TYPE,
  detectPrintType,
  findUploadedFile,
  propertyMm,
  visibleProperties,
  type LineProperty,
} from "../lib/print-jobs";

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

interface WebhookLineItem {
  id: number;
  product_id?: number | null;
  title?: string;
  variant_title?: string | null;
  quantity?: number;
  price?: string;
  requires_shipping?: boolean;
  properties: LineProperty[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);

  const order = payload as {
    id: number;
    name?: string;
    email?: string | null;
    phone?: string | null;
    customer?: { first_name?: string | null; last_name?: string | null } | null;
    shipping_address?: WebhookAddress | null;
    billing_address?: WebhookAddress | null;
    line_items: WebhookLineItem[];
  };
  const lineItems = order.line_items || [];

  /*
   * Product types decide what is printed. The webhook does not carry them,
   * so look them up once. If that fails the product titles still classify
   * the DTF lines, just without a custom type such as "PolyBlock".
   */
  const productTypes = new Map<string, string>();
  const productIds = [
    ...new Set(lineItems.map((li) => li.product_id).filter(Boolean).map(String)),
  ];
  if (admin && productIds.length > 0) {
    try {
      const res = await admin.graphql(
        `#graphql
        query PrintProductTypes($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Product { id productType } }
        }`,
        { variables: { ids: productIds.map((id) => `gid://shopify/Product/${id}`) } },
      );
      const body = await res.json();
      for (const node of body.data?.nodes ?? []) {
        if (node?.id) productTypes.set(node.id.split("/").pop(), node.productType || "");
      }
    } catch (error) {
      console.error(`[orders-paid] Could not look up product types for ${order.id}:`, error);
    }
  }

  const gangSheetIdOf = (li: WebhookLineItem) =>
    li.properties?.find((p) => p.name === "_gang_sheet_id")?.value;
  const printTypeOf = (li: WebhookLineItem) =>
    gangSheetIdOf(li)
      ? detectPrintType(productTypes.get(String(li.product_id)), li.title) ?? DEFAULT_PRINT_TYPE
      : detectPrintType(productTypes.get(String(li.product_id)), li.title);

  /*
   * Everything printed leaves the print shop in Poland in one BWS parcel.
   * What is left — presses, blanks — ships some other way, so remember it:
   * the admin warns about it and auto-booking leaves mixed orders alone.
   */
  const otherLineItems = lineItems
    .filter((li) => li.requires_shipping !== false && !printTypeOf(li))
    .map((li) => ({
      title: [li.title, li.variant_title].filter(Boolean).join(" – "),
      quantity: li.quantity ?? 1,
    }));

  const ship = order.shipping_address || order.billing_address || null;
  const orderDetails = {
    shopifyOrderId: String(order.id),
    orderName: order.name ? String(order.name) : null,
    otherLineItems: otherLineItems.length > 0 ? otherLineItems : Prisma.DbNull,
    customerName:
      ship?.name ||
      [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") ||
      null,
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
  };

  // Each line item is handled on its own so one bad line cannot fail the
  // webhook — Shopify retries non-200 responses over and over.
  for (const lineItem of lineItems) {
    try {
      const printType = printTypeOf(lineItem);
      if (!printType) continue;

      const lineDetails = {
        shopifyLineItemId: String(lineItem.id),
        printType,
        productTitle: lineItem.title ?? null,
        variantTitle: lineItem.variant_title ?? null,
        lineQuantity: lineItem.quantity ?? 1,
        lineProperties: visibleProperties(lineItem.properties || []).map((p) => ({
          name: String(p.name),
          value: String(p.value),
        })) as Prisma.InputJsonArray,
      };

      const gangSheetId = gangSheetIdOf(lineItem);
      const jobId = gangSheetId
        ? await linkGangSheet(shop, gangSheetId, order.id)
        : await createCutJob(shop, order.id, lineItem);
      if (!jobId) continue;

      // A redelivery of an order already in production must not send it back
      // to "Preparing file" — that used to reset printed sheets.
      const current = await prisma.gangSheet.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      const fresh = !current || current.status === "draft" || current.status === "pending";

      await prisma.gangSheet.update({
        where: { id: jobId },
        data: { ...orderDetails, ...lineDetails, ...(fresh ? { status: "pending" } : {}) },
      });
      if (!fresh) continue;

      // Deterministic jobId, so a webhook redelivery does not queue it twice.
      const jobData: ExportJobData = { gangSheetId: jobId, shopDomain: shop };
      await getExportQueue().add(`export-${jobId}`, jobData, {
        jobId: `export-${jobId}-${order.id}`,
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

/** The app-built gang sheet on this line, if it exists and is this shop's. */
async function linkGangSheet(shop: string, gangSheetId: string, orderId: number) {
  const gangSheet = await prisma.gangSheet.findUnique({
    where: { id: gangSheetId },
    select: { id: true, shopDomain: true },
  });
  if (!gangSheet) {
    console.warn(`[orders-paid] Gang sheet ${gangSheetId} not found (order ${orderId}, shop ${shop})`);
    return null;
  }
  if (gangSheet.shopDomain !== shop) {
    console.warn(`[orders-paid] Gang sheet ${gangSheetId} belongs to ${gangSheet.shopDomain}, not ${shop} — skipping`);
    return null;
  }
  return gangSheet.id;
}

/**
 * A job for a line the app did not build: the customer's motif, printed the
 * ordered number of times and cut out. Found again by line item id, so a
 * webhook redelivery does not create a second job.
 */
async function createCutJob(shop: string, orderId: number, lineItem: WebhookLineItem) {
  const existing = await prisma.gangSheet.findFirst({
    where: { shopDomain: shop, shopifyLineItemId: String(lineItem.id) },
    select: { id: true },
  });
  if (existing) return existing.id;

  const properties = lineItem.properties || [];
  const quantity = lineItem.quantity ?? 1;
  const unitPrice = parseFloat(lineItem.price || "");

  const job = await prisma.gangSheet.create({
    data: {
      sessionId: `order-${orderId}`,
      shopDomain: shop,
      kind: "cut",
      widthMm: propertyMm(properties, /bredd|width/i),
      heightMm: propertyMm(properties, /höjd|hojd|height/i),
      sourceFileUrl: findUploadedFile(properties),
      priceSEK: Number.isFinite(unitPrice) ? Math.round(unitPrice * quantity) : null,
      status: "pending",
    },
    select: { id: true },
  });
  return job.id;
}

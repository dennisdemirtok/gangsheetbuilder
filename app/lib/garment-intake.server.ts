import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { isGarment, type GarmentItem } from "./garments";

/**
 * Record an order's clothes for the Clothes list. Called from the order intake
 * next to the print jobs, never instead of them: a garment line is not printed
 * here, it is dropshipped from Printgood after Feelgood approves the pickup.
 */

interface GarmentLine {
  id: number;
  product_id?: number | null;
  title?: string;
  variant_title?: string | null;
  sku?: string | null;
  vendor?: string | null;
  quantity?: number;
  price?: string;
}

interface GarmentAddress {
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

export interface GarmentOrderPayload {
  id: number;
  name?: string;
  email?: string | null;
  phone?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  shipping_address?: GarmentAddress | null;
  billing_address?: GarmentAddress | null;
  line_items: GarmentLine[];
}

export async function intakeGarments(
  shop: string,
  order: GarmentOrderPayload,
  productTypes: Map<string, string>,
): Promise<void> {
  const items: GarmentItem[] = (order.line_items || [])
    .filter((li) => (li.quantity ?? 0) > 0 && isGarment(li, productTypes.get(String(li.product_id))))
    .map((li) => {
      const price = parseFloat(li.price || "");
      return {
        lineItemId: String(li.id),
        title: li.title ?? "",
        variantTitle: li.variant_title ?? null,
        sku: li.sku || null,
        quantity: li.quantity ?? 1,
        vendor: li.vendor ?? null,
        unitPrice: Number.isFinite(price) ? price : null,
      };
    });
  if (items.length === 0) return;

  const key = { shopDomain: shop, shopifyOrderId: String(order.id) };
  const existing = await prisma.garmentOrder.findUnique({
    where: { shopDomain_shopifyOrderId: key },
    select: { status: true },
  });
  // Once Feelgood has the order, a webhook redelivery must not change it.
  if (existing && existing.status !== "new") return;

  const ship = order.shipping_address || order.billing_address || null;
  const data = {
    orderName: order.name ? String(order.name) : null,
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
    items: items as unknown as Prisma.InputJsonArray,
  };
  await prisma.garmentOrder.upsert({
    where: { shopDomain_shopifyOrderId: key },
    create: { ...key, ...data },
    update: data,
  });
}

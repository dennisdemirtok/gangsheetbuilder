import prisma from "../db.server";
import {
  createBwsShipment,
  defaultPickupDate,
  pickupDateTime,
  PICKUP_TIME,
  type BwsAddress,
} from "./bws-shipping.server";
import {
  GARMENT_PACKAGE_CM,
  GARMENT_PICKUP,
  estimateWeightKg,
  garmentsValueSEK,
  type GarmentItem,
} from "./garments";
import { trackingUrlFor } from "./order-shipment.server";
import { normalizePhone } from "./phone";
import { uploadFile } from "./r2.server";
import { fulfillLineItemsWithTracking } from "./shopify-fulfillment.server";

/**
 * The clothes' own parcel: collected at Printgood in Kryspinów, not at the
 * print shop, and only once Feelgood has approved the pickup. The print
 * order's BWS booking is never touched.
 */

interface StoredAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  email?: string | null;
}

export type GarmentBookResult = { ok: true; trackingNumbers: string[] } | { ok: false; errors: string[] };

export async function bookGarmentPickup(options: {
  shopDomain: string;
  id: string;
  pickupDate?: string;
  weightKg?: number;
  service?: string;
  packageCm?: { length: number; width: number; height: number };
}): Promise<GarmentBookResult> {
  const { shopDomain, id } = options;
  // Claim first: a double click must not book two couriers.
  const claim = await prisma.garmentOrder.updateMany({
    where: { id, shopDomain, status: { not: "cancelled" }, OR: [{ shippingStatus: null }, { shippingStatus: "failed" }] },
    data: { shippingStatus: "booking", shippingError: null },
  });
  if (claim.count === 0) {
    return { ok: false, errors: ["This pickup is already booked (or a booking is in progress)."] };
  }
  const fail = async (errors: string[]) => {
    await prisma.garmentOrder.update({
      where: { id },
      data: { shippingStatus: "failed", shippingError: errors.join(" · ").slice(0, 2000) },
    });
    return { ok: false as const, errors };
  };

  try {
    const order = await prisma.garmentOrder.findUniqueOrThrow({ where: { id } });
    const items = order.items as unknown as GarmentItem[];
    const address = (order.shippingAddress as StoredAddress | null) || null;
    if (!address?.address1 || !address.zip || !address.city) {
      return fail(["The order's shipping address is missing the street, postcode or city."]);
    }
    const recipient: BwsAddress = {
      name: address.name || order.customerName || "Customer",
      company: address.company || undefined,
      address1: address.address1,
      address2: address.address2 || undefined,
      zip: address.zip,
      city: address.city,
      countryCode: address.countryCode || "SE",
      phone:
        normalizePhone(address.phone || "", address.countryCode) ||
        process.env.BWS_FALLBACK_PHONE ||
        undefined,
      email: address.email || undefined,
    };

    const earliest = defaultPickupDate();
    const pickupDate = options.pickupDate || earliest;
    if (pickupDate < earliest) {
      return fail([`The ${PICKUP_TIME} pickup on ${pickupDate} has passed. The earliest pickup is ${earliest}.`]);
    }

    const result = await createBwsShipment({
      reference: `${order.orderName || `#${order.shopifyOrderId}`} garments`,
      recipient,
      pickupDate,
      weightKg: options.weightKg || estimateWeightKg(items),
      valueSEK: garmentsValueSEK(items),
      description: "Garments (textile)",
      service: options.service,
      pickup: GARMENT_PICKUP,
      packageCm: options.packageCm || GARMENT_PACKAGE_CM,
    });
    if (!result.success) return fail(result.errors);

    let labelKey: string | null = null;
    if (result.label) {
      labelKey = `labels/${order.shopifyOrderId}/garments-label.${result.label.extension}`;
      await uploadFile(labelKey, result.label.data, result.label.contentType);
    }

    // The customer hears at the pickup time (fulfillDueGarmentPickups), as with prints.
    await prisma.garmentOrder.update({
      where: { id },
      data: {
        status: "booked",
        shippingStatus: "booked",
        bwsBookingId: result.bookingId || null,
        trackingNumber: result.trackingNumbers.join(", ") || null,
        trackingUrl: result.trackingUrl || null,
        shippingLabelKey: labelKey,
        shippingService: options.service || null,
        shippingPrice: result.price?.amount ?? null,
        shippingCurrency: result.price?.currency ?? null,
        pickupDate,
        shippingBookedAt: new Date(),
        shippingError: null,
        shopifyFulfillmentId: null,
        fulfillmentError: null,
      },
    });
    return { ok: true, trackingNumbers: result.trackingNumbers };
  } catch (error) {
    return fail([`Booking aborted: ${(error as Error).message}`]).catch(() => ({
      ok: false as const,
      errors: [(error as Error).message],
    }));
  }
}

/** Fulfil the garment lines in Shopify with the tracking: the customer's shipping email. */
export async function sendGarmentTracking(
  shopDomain: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const order = await prisma.garmentOrder.findFirst({ where: { id, shopDomain } });
  if (!order || !order.trackingNumber) return { ok: false, error: "There is no tracking number yet." };
  const items = order.items as unknown as GarmentItem[];
  const fulfillment = await fulfillLineItemsWithTracking({
    shopDomain,
    shopifyOrderId: order.shopifyOrderId,
    lineItemIds: items.map((i) => i.lineItemId),
    trackingNumber: order.trackingNumber.split(", ")[0],
    trackingUrl: order.trackingUrl || undefined,
  });
  await prisma.garmentOrder.update({
    where: { id },
    data: fulfillment.ok
      ? {
          shopifyFulfillmentId: fulfillment.fulfillmentIds.join(","),
          fulfillmentError: null,
          status: "shipped",
          shippedAt: new Date(),
        }
      : { fulfillmentError: fulfillment.error },
  });
  return fulfillment.ok ? { ok: true } : { ok: false, error: fulfillment.error };
}

/** Booked by hand (BWS portal) or shipped another way: record it and tell the customer. */
export async function markGarmentShipped(options: {
  shopDomain: string;
  id: string;
  trackingNumber: string;
}): Promise<{ ok: boolean; error?: string }> {
  const tracking = options.trackingNumber.replace(/\s+/g, "");
  if (!tracking) return { ok: false, error: "Enter the tracking number." };
  await prisma.garmentOrder.updateMany({
    where: { id: options.id, shopDomain: options.shopDomain },
    data: { trackingNumber: tracking, trackingUrl: trackingUrlFor(tracking), fulfillmentError: null },
  });
  return sendGarmentTracking(options.shopDomain, options.id);
}

/** Worker sweep: once the courier has come at Printgood, the customer gets the tracking. */
export async function fulfillDueGarmentPickups(now: Date = new Date()): Promise<number> {
  const due = await prisma.garmentOrder.findMany({
    where: { status: "booked", shopifyFulfillmentId: null, fulfillmentError: null, pickupDate: { not: null } },
    select: { id: true, shopDomain: true, pickupDate: true, orderName: true },
  });
  let sent = 0;
  for (const order of due) {
    if (pickupDateTime(order.pickupDate!) > now) continue;
    const result = await sendGarmentTracking(order.shopDomain, order.id);
    if (result.ok) sent++;
    else console.error(`[garments] ${order.orderName}: ${result.error}`);
  }
  return sent;
}

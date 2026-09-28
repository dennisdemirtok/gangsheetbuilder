import prisma from "../db.server";
import { filmMetres } from "./print-jobs";
import { normalizePhone } from "./phone";
import { uploadFile } from "./r2.server";
import { fulfillLineItemsWithTracking } from "./shopify-fulfillment.server";
import {
  createBwsShipment,
  defaultPickupDate,
  pickupDateTime,
  PICKUP_TIME,
  weightForMeters,
  type BwsAddress,
} from "./bws-shipping.server";

/**
 * Book one BWS pickup for a whole Shopify order.
 *
 * An order can hold several print jobs (one per line item: gang sheets and
 * cut transfers) but they leave Poland in one tube, so the booking — and its label and tracking — is per
 * order and copied onto every sheet of it.
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

export interface OrderShipmentSummary {
  meters: number;
  weightKg: number;
  valueSEK: number;
  pickupDate: string;
  sheetCount: number;
  /** Presses/blanks on the order — not part of this shipment. */
  otherLineItems: { title: string; quantity: number }[];
}

async function loadOrderSheets(shopDomain: string, shopifyOrderId: string) {
  return prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId },
    orderBy: { createdAt: "asc" },
  });
}

export async function summarizeOrderShipment(
  shopDomain: string,
  shopifyOrderId: string,
): Promise<OrderShipmentSummary> {
  const sheets = await loadOrderSheets(shopDomain, shopifyOrderId);
  // Every printed line on the order travels in the tube — gang sheets and
  // cut transfers alike — so weight is estimated from the film they use.
  const meters = sheets.reduce((sum, s) => sum + filmMetres(s), 0);
  return {
    meters: Math.round(meters * 10) / 10,
    weightKg: weightForMeters(meters),
    valueSEK: sheets.reduce((sum, s) => sum + (s.priceSEK || 0), 0),
    pickupDate: defaultPickupDate(),
    sheetCount: sheets.length,
    otherLineItems:
      (sheets[0]?.otherLineItems as { title: string; quantity: number }[] | null) || [],
  };
}

export type BookOrderResult =
  | {
      ok: true;
      bookingId?: string;
      trackingNumbers: string[];
      fulfillmentError?: string;
    }
  | { ok: false; errors: string[] };

export async function bookOrderShipment(options: {
  shopDomain: string;
  shopifyOrderId: string;
  pickupDate?: string;
  weightKg?: number;
  /** ServiceType code the shop picked: EXP (Blue Express) or ECO (Blue Economy). */
  service?: string;
}): Promise<BookOrderResult> {
  const { shopDomain, shopifyOrderId } = options;
  const where = { shopDomain, shopifyOrderId };

  // Claim the order first. A webhook redelivery or a double click would
  // otherwise book two couriers for one tube. "failed" may be retried.
  const claim = await prisma.gangSheet.updateMany({
    where: {
      ...where,
      OR: [{ shippingStatus: null }, { shippingStatus: "failed" }],
    },
    data: { shippingStatus: "booking", shippingError: null },
  });
  if (claim.count === 0) {
    return { ok: false, errors: ["This order is already booked with BWS (or a booking is in progress)."] };
  }

  try {
    const sheets = await loadOrderSheets(shopDomain, shopifyOrderId);
    const first = sheets[0];
    const address = (first?.shippingAddress as StoredAddress | null) || null;
    const summary = await summarizeOrderShipment(shopDomain, shopifyOrderId);

    const addressErrors: string[] = [];
    if (!address) addressErrors.push("The order has no shipping address.");
    else {
      if (!address.address1) addressErrors.push("The shipping address has no street.");
      if (!address.zip) addressErrors.push("The shipping address has no postcode.");
      if (!address.city) addressErrors.push("The shipping address has no city.");
    }
    if (addressErrors.length > 0) {
      await fail(where, addressErrors);
      return { ok: false, errors: addressErrors };
    }

    const recipient: BwsAddress = {
      name: address!.name || first.customerName || "Customer",
      company: address!.company || undefined,
      address1: address!.address1!,
      address2: address!.address2 || undefined,
      zip: address!.zip!,
      city: address!.city!,
      countryCode: address!.countryCode || "SE",
      // Couriers want a phone number for delivery; orders placed without
      // one fall back to the shop's own number so the booking still goes.
      phone:
        normalizePhone(address!.phone || "", address!.countryCode) ||
        process.env.BWS_FALLBACK_PHONE ||
        undefined,
      email: address!.email || undefined,
    };

    const reference = first.orderName || `#${shopifyOrderId}`;
    /*
     * The courier comes at 11:30 in Łódź. Past that, the same day is gone —
     * summary.pickupDate is the earliest slot left (and skips weekends), so a
     * date picked by hand can only be later than it, never earlier.
     */
    const pickupDate = options.pickupDate || summary.pickupDate;
    if (pickupDate < summary.pickupDate) {
      const errors = [
        `The ${PICKUP_TIME} pickup on ${pickupDate} has passed. The earliest pickup is ${summary.pickupDate}.`,
      ];
      await fail(where, errors);
      return { ok: false, errors };
    }
    const result = await createBwsShipment({
      reference,
      recipient,
      pickupDate,
      weightKg: options.weightKg || summary.weightKg,
      valueSEK: summary.valueSEK,
      service: options.service,
    });

    if (!result.success) {
      await fail(where, result.errors);
      return { ok: false, errors: result.errors };
    }

    let labelKey: string | null = null;
    if (result.label) {
      labelKey = `labels/${shopifyOrderId}/bws-label.${result.label.extension}`;
      await uploadFile(labelKey, result.label.data, result.label.contentType);
    }

    /*
     * The customer is NOT told yet. Booking happens when the files go to the
     * print shop, often the day before the courier comes; a "your order has
     * shipped" email then would be a day early and the tracking link empty.
     * fulfillDuePickups() fulfils the order in Shopify at the pickup time,
     * which is what sends the customer Shopify's shipping confirmation.
     */
    const trackingNumber = result.trackingNumbers.join(", ") || undefined;

    await prisma.gangSheet.updateMany({
      where,
      data: {
        shopifyFulfillmentId: null,
        fulfillmentError: null,
        shippingStatus: "booked",
        bwsBookingId: result.bookingId || null,
        trackingNumber: trackingNumber || null,
        trackingUrl: result.trackingUrl || null,
        shippingLabelKey: labelKey,
        shippingService: options.service || null,
        // What BWS charged. Their rate is only returned with the booking.
        shippingPrice: result.price?.amount ?? null,
        shippingCurrency: result.price?.currency ?? null,
        pickupDate,
        shippingBookedAt: new Date(),
        shippingError: null,
      },
    });

    return {
      ok: true,
      bookingId: result.bookingId,
      trackingNumbers: result.trackingNumbers,
    };
  } catch (error) {
    const errors = [`Booking aborted: ${(error as Error).message}`];
    await fail(where, errors).catch(() => {});
    return { ok: false, errors };
  }
}

/** Retry telling the customer after a booking whose Shopify fulfilment failed. */
export async function sendTrackingToCustomer(
  shopDomain: string,
  shopifyOrderId: string,
): Promise<{ ok: boolean; error?: string }> {
  const sheets = await loadOrderSheets(shopDomain, shopifyOrderId);
  const first = sheets[0];
  if (!first || first.shippingStatus !== "booked") {
    return { ok: false, error: "Book the shipment first." };
  }
  const fulfillment = await fulfillLineItemsWithTracking({
    shopDomain,
    shopifyOrderId,
    lineItemIds: sheets
      .map((s) => s.shopifyLineItemId)
      .filter((id): id is string => Boolean(id)),
    trackingNumber: first.trackingNumber?.split(", ")[0],
    trackingUrl: first.trackingUrl || undefined,
  });
  await prisma.gangSheet.updateMany({
    where: { shopDomain, shopifyOrderId },
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

async function fail(
  where: { shopDomain: string; shopifyOrderId: string },
  errors: string[],
) {
  await prisma.gangSheet.updateMany({
    where,
    data: { shippingStatus: "failed", shippingError: errors.join(" · ").slice(0, 2000) },
  });
}

/**
 * Tell customers their order is on its way once the courier has collected it.
 *
 * Runs every few minutes in the worker. Any booked order whose pickup time
 * has passed and that is not yet fulfilled in Shopify gets fulfilled with the
 * BWS tracking, which sends the customer Shopify's shipping confirmation.
 * Kept as a sweep over the database rather than a delayed job, so nothing is
 * lost if the queue restarts.
 */
export async function fulfillDuePickups(now: Date = new Date()): Promise<number> {
  const due = await prisma.gangSheet.findMany({
    where: {
      shippingStatus: "booked",
      shopifyFulfillmentId: null,
      fulfillmentError: null,
      pickupDate: { not: null },
      shopifyOrderId: { not: null },
    },
    select: { shopDomain: true, shopifyOrderId: true, pickupDate: true },
    distinct: ["shopDomain", "shopifyOrderId"],
  });

  let sent = 0;
  for (const order of due) {
    if (pickupDateTime(order.pickupDate!) > now) continue;
    const result = await sendTrackingToCustomer(order.shopDomain, order.shopifyOrderId!);
    if (result.ok) sent++;
    else console.error(`[tracking] ${order.shopifyOrderId}: ${result.error}`);
  }
  return sent;
}

/** A carrier tracking link from the number on the label. */
export function trackingUrlFor(trackingNumber: string): string | null {
  const n = trackingNumber.replace(/\s+/g, "");
  if (/^1Z[0-9A-Z]{16}$/i.test(n)) return `https://www.ups.com/track?tracknum=${n}`;
  if (/^\d{12}$|^\d{15}$|^\d{20,22}$/.test(n)) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (/^\d{10}$/.test(n)) return `https://www.dhl.com/se-sv/home/tracking.html?tracking-id=${n}`;
  return null;
}

/**
 * Record a pickup booked by hand in the BWS portal, with its label.
 *
 * The API can create bookings but not fetch one made elsewhere, so the shop
 * uploads the label PDF. From here the order behaves exactly like an app
 * booking: the label goes to the print shop, and the customer gets the
 * tracking email at the pickup time.
 */
export async function registerManualBooking(options: {
  shopDomain: string;
  shopifyOrderId: string;
  bookingId: string;
  trackingNumber: string;
  pickupDate: string;
  service?: string;
  label?: { buffer: Buffer; filename: string };
}): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const where = { shopDomain: options.shopDomain, shopifyOrderId: options.shopifyOrderId };
  const tracking = options.trackingNumber.replace(/\s+/g, "");
  if (!options.bookingId.trim() && !tracking) {
    return { ok: false, errors: ["Enter the BWS booking number or the tracking number."] };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.pickupDate)) {
    return { ok: false, errors: ["Enter the pickup date."] };
  }

  let labelKey: string | null = null;
  if (options.label) {
    const ext = (options.label.filename.split(".").pop() || "pdf").toLowerCase().slice(0, 4);
    labelKey = `labels/${options.shopifyOrderId}/bws-label-${Date.now().toString(36)}.${ext}`;
    await uploadFile(labelKey, options.label.buffer, ext === "pdf" ? "application/pdf" : "application/octet-stream");
  }

  await prisma.gangSheet.updateMany({
    where,
    data: {
      shippingStatus: "booked",
      shippingError: null,
      bwsBookingId: options.bookingId.trim() || null,
      trackingNumber: tracking || null,
      trackingUrl: tracking ? trackingUrlFor(tracking) : null,
      pickupDate: options.pickupDate,
      shippingService: options.service || null,
      shippingPrice: null,
      shippingCurrency: null,
      shippingBookedAt: new Date(),
      shopifyFulfillmentId: null,
      fulfillmentError: null,
      ...(labelKey ? { shippingLabelKey: labelKey } : {}),
    },
  });
  return { ok: true };
}

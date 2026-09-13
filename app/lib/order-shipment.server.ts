import prisma from "../db.server";
import { filmMetres } from "./print-jobs";
import { uploadFile } from "./r2.server";
import { fulfillLineItemsWithTracking } from "./shopify-fulfillment.server";
import {
  createBwsShipment,
  defaultPickupDate,
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
      phone: address!.phone || undefined,
      email: address!.email || undefined,
    };

    const reference = first.orderName || `#${shopifyOrderId}`;
    const pickupDate = options.pickupDate || summary.pickupDate;
    const result = await createBwsShipment({
      reference,
      recipient,
      pickupDate,
      weightKg: options.weightKg || summary.weightKg,
      valueSEK: summary.valueSEK,
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

    // Tell the customer: fulfil the DTF line items with the tracking, which
    // makes Shopify send its shipping confirmation. Presses and blanks on the
    // same order are left untouched.
    const trackingNumber = result.trackingNumbers.join(", ") || undefined;
    const fulfillment = await fulfillLineItemsWithTracking({
      shopDomain,
      shopifyOrderId,
      lineItemIds: sheets
        .map((s) => s.shopifyLineItemId)
        .filter((id): id is string => Boolean(id)),
      trackingNumber: result.trackingNumbers[0],
      trackingUrl: result.trackingUrl,
    });

    await prisma.gangSheet.updateMany({
      where,
      data: {
        shopifyFulfillmentId: fulfillment.ok ? fulfillment.fulfillmentIds.join(",") : null,
        fulfillmentError: fulfillment.ok ? null : fulfillment.error,
        ...(fulfillment.ok ? { status: "shipped", shippedAt: new Date() } : {}),
        shippingStatus: "booked",
        bwsBookingId: result.bookingId || null,
        trackingNumber: trackingNumber || null,
        trackingUrl: result.trackingUrl || null,
        shippingLabelKey: labelKey,
        pickupDate,
        shippingBookedAt: new Date(),
        shippingError: null,
      },
    });

    return {
      ok: true,
      bookingId: result.bookingId,
      trackingNumbers: result.trackingNumbers,
      fulfillmentError: fulfillment.ok ? undefined : fulfillment.error,
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

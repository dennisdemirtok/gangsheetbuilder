import prisma from "../db.server";
import { createBwsShipment, defaultPickupDate, PICKUP_TIME, type BwsAddress } from "./bws-shipping.server";
import { summarizeOrderShipment } from "./order-shipment.server";
import { normalizePhone } from "./phone";
import { uploadFile } from "./r2.server";

/**
 * One more BWS pickup for an order that already went out once — a reprint
 * after a complaint, a wrong motif, a parcel lost on the way.
 *
 * The order's own booking is never touched: its tracking, the customer's
 * shipping email and the missed-delivery check all stay with the first
 * parcel. Nothing is emailed and nothing reaches Shopify; the shop downloads
 * the label and sends it to the print shop itself.
 */

export interface ExtraRecipient {
  name: string;
  company?: string | null;
  address1: string;
  address2?: string | null;
  zip: string;
  city: string;
  countryCode: string;
  phone?: string | null;
  email?: string | null;
}

export type ExtraBookResult =
  | { ok: true; reference: string; trackingNumbers: string[]; labelMissing: boolean }
  | { ok: false; errors: string[] };

/** A booking still "booking" after this long was cut off mid-request; it no longer blocks. */
const CLAIM_MS = 2 * 60_000;

export async function listExtraShipments(shopDomain: string, shopifyOrderId: string) {
  return prisma.extraShipment.findMany({
    where: { shopDomain, shopifyOrderId, status: "booked" },
    orderBy: { createdAt: "asc" },
  });
}

export async function bookExtraShipment(options: {
  shopDomain: string;
  shopifyOrderId: string;
  orderName: string;
  recipient: ExtraRecipient;
  reason?: string;
  pickupDate?: string;
  weightKg?: number;
  service?: string;
}): Promise<ExtraBookResult> {
  const { shopDomain, shopifyOrderId, recipient } = options;

  const missing = [
    !recipient.name.trim() && "name",
    !recipient.address1.trim() && "street",
    !recipient.zip.trim() && "postcode",
    !recipient.city.trim() && "city",
    !/^[A-Z]{2}$/.test(recipient.countryCode) && "country code",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, errors: [`The address is missing the ${missing.join(", ")}.`] };
  }

  const earliest = defaultPickupDate();
  const pickupDate = options.pickupDate || earliest;
  if (pickupDate < earliest) {
    return {
      ok: false,
      errors: [`The ${PICKUP_TIME} pickup on ${pickupDate} has passed. The earliest pickup is ${earliest}.`],
    };
  }

  // A double click must not book two couriers.
  const pending = await prisma.extraShipment.count({
    where: {
      shopDomain,
      shopifyOrderId,
      status: "booking",
      createdAt: { gt: new Date(Date.now() - CLAIM_MS) },
    },
  });
  if (pending > 0) return { ok: false, errors: ["An extra booking for this order is already in progress."] };

  // "#1108-2" for the order's second parcel, "#1108-3" for the third.
  const booked = await prisma.extraShipment.count({ where: { shopDomain, shopifyOrderId, status: "booked" } });
  const reference = `${options.orderName}-${booked + 2}`;
  const summary = await summarizeOrderShipment(shopDomain, shopifyOrderId);
  const weightKg = options.weightKg || summary.weightKg;

  const claim = await prisma.extraShipment.create({
    data: {
      shopDomain,
      shopifyOrderId,
      reference,
      reason: options.reason?.trim().slice(0, 500) || null,
      recipient: { ...recipient },
      pickupDate,
      weightKg,
      shippingService: options.service || null,
    },
  });
  // A failed booking leaves nothing behind: the next try gets the same reference.
  const fail = async (errors: string[]) => {
    await prisma.extraShipment.delete({ where: { id: claim.id } }).catch(() => {});
    return { ok: false as const, errors };
  };

  const to: BwsAddress = {
    name: recipient.name.trim(),
    company: recipient.company?.trim() || undefined,
    address1: recipient.address1.trim(),
    address2: recipient.address2?.trim() || undefined,
    zip: recipient.zip.trim(),
    city: recipient.city.trim(),
    countryCode: recipient.countryCode,
    phone:
      normalizePhone(recipient.phone || "", recipient.countryCode) ||
      process.env.BWS_FALLBACK_PHONE ||
      undefined,
    email: recipient.email?.trim() || undefined,
  };
  let result: Awaited<ReturnType<typeof createBwsShipment>>;
  try {
    result = await createBwsShipment({
      reference,
      recipient: to,
      pickupDate,
      weightKg,
      valueSEK: summary.valueSEK,
      service: options.service,
    });
  } catch (error) {
    return fail([`Booking aborted: ${(error as Error).message}`]);
  }
  if (!result.success) return fail(result.errors);

  // BWS has booked the courier now; from here the row must stay, label or not.
  let labelKey: string | null = null;
  if (result.label) {
    const key = `labels/${shopifyOrderId}/extra-${claim.id}.${result.label.extension}`;
    try {
      await uploadFile(key, result.label.data, result.label.contentType);
      labelKey = key;
    } catch (error) {
      console.error(`[BWS] Label for ${reference} not stored:`, error);
    }
  }
  const trackingNumber = result.trackingNumbers.join(", ") || null;

  await prisma.extraShipment.update({
    where: { id: claim.id },
    data: {
      status: "booked",
      bwsBookingId: result.bookingId || null,
      trackingNumber,
      trackingUrl: result.trackingUrl || null,
      shippingLabelKey: labelKey,
      shippingPrice: result.price?.amount ?? null,
      shippingCurrency: result.price?.currency ?? null,
    },
  });

  // On the order's notes too, next to the rest of its history.
  const firstJob = await prisma.gangSheet.findFirst({
    where: { shopDomain, shopifyOrderId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (firstJob) {
    await prisma.gangSheetNote.create({
      data: {
        gangSheetId: firstJob.id,
        author: shopDomain,
        body: [
          `Extra BWS booking ${reference}`,
          result.bookingId,
          trackingNumber && `tracking ${trackingNumber}`,
          `pickup ${pickupDate}`,
          options.reason?.trim(),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 2000),
      },
    });
  }

  return {
    ok: true,
    reference,
    trackingNumbers: result.trackingNumbers,
    labelMissing: !labelKey,
  };
}

import type { GangSheet } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendMail, mailFrom } from "./mailer.server";
import { orderLabel } from "./order-status";
import { SIMULATED_PREFIX } from "./bws-shipping.server";

/**
 * Stuck shipments: parcels booked with BWS that the carrier never scanned.
 *
 * #1176 was booked on 2026-11-06 and FedEx never picked it up. Shopify kept
 * showing "Shipment information sent to FedEx" and nobody noticed until the
 * customer asked two weeks later. So every weekday morning the shop gets one
 * email listing the orders shipped two days ago or more whose tracking still
 * has no scan by the carrier. An order stays on the list each day until a
 * scan comes in or someone marks it as checked on the order page.
 */

const TIMEZONE = "Europe/Stockholm";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A parcel booked this long ago should have a carrier scan. */
const STUCK_AFTER_DAYS = 2;
/** Older bookings are no longer followed. */
const FOLLOW_DAYS = 45;
/** The digest goes out at this hour (Stockholm), Monday to Friday. */
export const DIGEST_HOUR = 8;

/**
 * Fulfillment event statuses that only say the label exists. Anything else
 * (CARRIER_PICKED_UP, IN_TRANSIT, DELIVERED, FAILURE …) means the carrier has
 * the parcel, or has at least said something about it.
 */
const NO_SCAN_STATUSES = new Set(["CONFIRMED", "LABEL_PRINTED", "LABEL_PURCHASED"]);

const ORDER_QUERY = `#graphql
  query StuckShipmentEvents($id: ID!) {
    order(id: $id) {
      id
      cancelledAt
      fulfillments(first: 10) {
        id
        displayStatus
        trackingInfo(first: 5) { number url }
        events(first: 20, sortKey: HAPPENED_AT, reverse: true) {
          nodes { status happenedAt }
        }
      }
    }
  }
`;

interface Fulfillment {
  id: string;
  displayStatus: string | null;
  trackingInfo: { number: string | null; url: string | null }[];
  events: { nodes: { status: string; happenedAt: string }[] };
}

const cleanNumber = (n: string | null | undefined) => (n || "").replace(/\s+/g, "");

/**
 * True when none of the app's fulfillments on the order has a carrier scan.
 * Fulfillments the app did not ship (presses, blanks) are ignored; with none
 * of ours found the order is not flagged, as there is nothing to judge.
 */
export function hasNoCarrierScan(
  fulfillments: Fulfillment[],
  ours: { fulfillmentIds: string[]; trackingNumbers: string[] },
): boolean {
  const ids = new Set(ours.fulfillmentIds);
  const numbers = new Set(ours.trackingNumbers.map(cleanNumber).filter(Boolean));
  const relevant = fulfillments.filter(
    (f) => ids.has(f.id) || f.trackingInfo.some((t) => numbers.has(cleanNumber(t.number))),
  );
  if (relevant.length === 0) return false;
  return relevant.every(
    (f) =>
      f.displayStatus !== "DELIVERED" &&
      f.events.nodes.every((e) => NO_SCAN_STATUSES.has(e.status)),
  );
}

export interface StuckShipment {
  order: string;
  shopDomain: string;
  shopifyOrderId: string;
  customerName: string | null;
  city: string | null;
  shippedAt: Date;
  pickupDate: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** The newest thing Shopify heard, e.g. "CONFIRMED", or null for no events at all. */
  lastStatus: string | null;
}

export interface StuckCheck {
  stuck: StuckShipment[];
  errors: { order: string; detail: string }[];
  checked: number;
}

/** Every booked order, shipped 2–45 days ago, not delivered or checked, without a carrier scan. */
export async function findStuckShipments(options: { now?: Date } = {}): Promise<StuckCheck> {
  const now = options.now || new Date();
  const sheets = await prisma.gangSheet.findMany({
    where: {
      shopifyOrderId: { not: null },
      shippedAt: {
        gte: new Date(now.getTime() - FOLLOW_DAYS * DAY_MS),
        lte: new Date(now.getTime() - STUCK_AFTER_DAYS * DAY_MS),
      },
      deliveredAt: null,
      shipmentCheckedAt: null,
      OR: [{ shopifyFulfillmentId: { not: null } }, { trackingNumber: { not: null } }],
    },
    orderBy: { shippedAt: "asc" },
  });

  // The shipping fields are the same on every job of an order: one per order.
  const orders = new Map<string, GangSheet>();
  for (const s of sheets) {
    const key = `${s.shopDomain}|${s.shopifyOrderId}`;
    if (!orders.has(key)) orders.set(key, s);
  }

  const result: StuckCheck = { stuck: [], errors: [], checked: 0 };
  for (const sheet of orders.values()) {
    if (sheet.trackingNumber?.startsWith(SIMULATED_PREFIX)) continue;
    const order = orderLabel(sheet);
    try {
      const { admin } = await unauthenticated.admin(sheet.shopDomain);
      const res = await admin.graphql(ORDER_QUERY, {
        variables: { id: `gid://shopify/Order/${sheet.shopifyOrderId}` },
      });
      const body: any = await res.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors));
      const shopifyOrder = body.data?.order;
      result.checked++;
      if (!shopifyOrder || shopifyOrder.cancelledAt) continue;

      const fulfillments: Fulfillment[] = shopifyOrder.fulfillments || [];
      const ours = {
        fulfillmentIds: (sheet.shopifyFulfillmentId || "").split(",").filter(Boolean),
        trackingNumbers: (sheet.trackingNumber || "").split(","),
      };
      if (!hasNoCarrierScan(fulfillments, ours)) continue;

      const lastEvent = fulfillments
        .flatMap((f) => f.events.nodes)
        .sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))[0];
      const address = (sheet.shippingAddress as Record<string, string | null> | null) || {};
      result.stuck.push({
        order,
        shopDomain: sheet.shopDomain,
        shopifyOrderId: sheet.shopifyOrderId!,
        customerName: sheet.customerName,
        city: address.city || null,
        shippedAt: sheet.shippedAt!,
        pickupDate: sheet.pickupDate,
        trackingNumber: cleanNumber(sheet.trackingNumber?.split(",")[0]) || null,
        trackingUrl: sheet.trackingUrl,
        lastStatus: lastEvent?.status || null,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : error instanceof Response ? `HTTP ${error.status}` : String(error);
      result.errors.push({ order, detail: detail.slice(0, 300) });
    }
  }
  return result;
}

/* ── Digest email (to the shop, Swedish) ──────────────────────────────── */

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const day = (at: Date) =>
  at.toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: TIMEZONE });

/** Shopify admin link to the order (the store handle is the myshopify subdomain). */
function adminOrderUrl(s: StuckShipment): string {
  const store = s.shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/orders/${s.shopifyOrderId}`;
}

/** A ready email to the print shop asking whether the parcel left. */
function printShopMailto(s: StuckShipment): string | null {
  const to = process.env.PRINT_SHOP_EMAIL;
  if (!to) return null;
  const subject = `Order ${s.order} – parcel not scanned by FedEx`;
  const body =
    `Hi,\n\nThe parcel for order ${s.order}` +
    (s.pickupDate ? ` (pickup ${s.pickupDate})` : "") +
    (s.trackingNumber ? `, tracking ${s.trackingNumber},` : "") +
    ` has not been scanned by FedEx yet. Was it handed to the courier, or is it still with you?\n\nThank you!`;
  return `mailto:${to.split(",")[0].trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function stuckShipmentsMail(check: StuckCheck, now: Date) {
  const n = check.stuck.length;
  const subject = `Paket utan skanning: ${n} ${n === 1 ? "order" : "ordrar"} (${check.stuck.map((s) => s.order).join(", ")})`;

  const rows = check.stuck.map((s) => {
    const days = Math.floor((now.getTime() - s.shippedAt.getTime()) / DAY_MS);
    const mailto = printShopMailto(s);
    const links = [
      `<a href="${esc(adminOrderUrl(s))}">Ordern</a>`,
      s.trackingUrl ? `<a href="${esc(s.trackingUrl)}">Spårning</a>` : null,
      mailto ? `<a href="${esc(mailto)}">Fråga tryckeriet</a>` : null,
    ].filter(Boolean);
    return {
      html:
        `<tr>` +
        `<td style="padding:8px 12px 8px 0;font-weight:700;white-space:nowrap;">${esc(s.order)}</td>` +
        `<td style="padding:8px 12px 8px 0;">${esc(s.customerName || "")}${s.city ? `, ${esc(s.city)}` : ""}</td>` +
        `<td style="padding:8px 12px 8px 0;white-space:nowrap;">bokad ${esc(day(s.shippedAt))} · <b>${days} dagar</b></td>` +
        `<td style="padding:8px 12px 8px 0;white-space:nowrap;">${esc(s.trackingNumber || "–")}</td>` +
        `<td style="padding:8px 0;white-space:nowrap;">${links.join(" · ")}</td>` +
        `</tr>`,
      text:
        `${s.order} – ${s.customerName || ""}${s.city ? `, ${s.city}` : ""} – bokad ${day(s.shippedAt)} (${days} dagar) – ` +
        `${s.trackingNumber || "ingen spårning"} – senaste status: ${s.lastStatus || "inga händelser"}\n` +
        `  Order: ${adminOrderUrl(s)}${s.trackingUrl ? `\n  Spårning: ${s.trackingUrl}` : ""}`,
    };
  });

  const errorNote = check.errors.length
    ? `Kunde inte kolla: ${check.errors.map((e) => `${e.order} (${e.detail})`).join("; ")}`
    : "";
  const intro =
    `De här paketen bokades för minst ${STUCK_AFTER_DAYS} dagar sedan men har ingen skanning från transportören ännu – ` +
    `bara "Shipment information sent to FedEx". De kan ligga kvar hos tryckeriet eller ha missats vid upphämtningen.`;
  const outro =
    `Kolla med tryckeriet eller BWS. När en order är utredd: tryck "Checked – stop reminding" på orderns fraktkort ` +
    `i appen, annars kommer den med i det här mejlet varje vardagsmorgon tills FedEx skannar paketet.`;

  const html = `<!doctype html><html lang="sv"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#111;">
<p>${esc(intro)}</p>
<table style="border-collapse:collapse;font-size:14px;">${rows.map((r) => r.html).join("")}</table>
<p style="color:#555;">${esc(outro)}</p>
${errorNote ? `<p style="color:#b00;">${esc(errorNote)}</p>` : ""}
</body></html>`;
  const text = [intro, "", ...rows.map((r) => r.text), "", outro, errorNote].join("\n").trim();
  return { subject, html, text };
}

/** Where the digest goes: SHIPMENT_ALERT_TO, else the shop's own mailbox. */
export function digestRecipient(): string | null {
  return process.env.SHIPMENT_ALERT_TO || process.env.SMTP_USER || null;
}

/**
 * Check and email the digest. Nothing is sent when no parcel is stuck.
 * `dryRun` returns the mail without sending it.
 */
export async function sendStuckShipmentDigest(options: { now?: Date; dryRun?: boolean } = {}) {
  const now = options.now || new Date();
  const check = await findStuckShipments({ now });
  if (check.stuck.length === 0) return { check, sent: false as const, mail: null };
  const mail = stuckShipmentsMail(check, now);
  if (options.dryRun) return { check, sent: false as const, mail };
  const to = digestRecipient();
  if (!to) throw new Error("No recipient: set SHIPMENT_ALERT_TO or SMTP_USER");
  await sendMail({ to, from: mailFrom(), subject: mail.subject, html: mail.html, text: mail.text });
  return { check, sent: true as const, mail };
}

/** "2026-11-24" and the hour, in Stockholm, plus whether it is a weekday. */
export function stockholmClock(at: Date): { day: string; hour: number; weekday: boolean } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: !["Sat", "Sun"].includes(get("weekday")),
  };
}

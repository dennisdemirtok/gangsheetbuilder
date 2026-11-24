import type { GangSheet } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendMail, mailFrom } from "./mailer.server";
import { orderLabel } from "./order-status";
import { SIMULATED_PREFIX } from "./bws-shipping.server";

/**
 * Stuck shipments: parcels booked with BWS that the carrier never scanned,
 * or that it scanned but then went quiet before delivery.
 *
 * #1176 was booked on 2026-11-06 and FedEx never picked it up. Shopify kept
 * showing "Shipment information sent to FedEx" and nobody noticed until the
 * customer asked two weeks later. So every weekday morning the shop gets one
 * email listing the orders shipped two days ago or more whose tracking still
 * has no scan by the carrier. An order stays on the list each day until a
 * scan comes in or someone marks it as checked on the order page.
 *
 * #1070 and #1150 showed the second case: FedEx scanned them on the way, then
 * nothing for weeks ("Package Delayed" in Helsingborg, "In transit" at Paris
 * CDG). Shopify kept showing them as on their way. So an order is also listed
 * when the newest carrier event is STALLED_AFTER_DAYS old and it is not
 * delivered; that includes a FAILURE nobody followed up (#1031 said FAILURE
 * for a parcel FedEx had delivered as "Damaged").
 */

const TIMEZONE = "Europe/Stockholm";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A parcel booked this long ago should have a carrier scan. */
const STUCK_AFTER_DAYS = 2;
/** A scanned parcel with no new carrier event for this long has stalled. */
const STALLED_AFTER_DAYS = 5;
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
          nodes { status happenedAt message }
        }
      }
    }
  }
`;

interface Fulfillment {
  id: string;
  displayStatus: string | null;
  trackingInfo: { number: string | null; url: string | null }[];
  events: { nodes: { status: string; happenedAt: string; message?: string | null }[] };
}

type FulfillmentEvent = Fulfillment["events"]["nodes"][number];

const cleanNumber = (n: string | null | undefined) => (n || "").replace(/\s+/g, "");

/**
 * True when none of the app's fulfillments on the order has a carrier scan.
 * Fulfillments the app did not ship (presses, blanks) are ignored; with none
 * of ours found the order is not flagged, as there is nothing to judge.
 */
function ourFulfillments(
  fulfillments: Fulfillment[],
  ours: { fulfillmentIds: string[]; trackingNumbers: string[] },
): Fulfillment[] {
  const ids = new Set(ours.fulfillmentIds);
  const numbers = new Set(ours.trackingNumbers.map(cleanNumber).filter(Boolean));
  return fulfillments.filter(
    (f) => ids.has(f.id) || f.trackingInfo.some((t) => numbers.has(cleanNumber(t.number))),
  );
}

const newestEvent = (f: Fulfillment): FulfillmentEvent | undefined =>
  [...f.events.nodes].sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))[0];

export function hasNoCarrierScan(
  fulfillments: Fulfillment[],
  ours: { fulfillmentIds: string[]; trackingNumbers: string[] },
): boolean {
  const relevant = ourFulfillments(fulfillments, ours);
  if (relevant.length === 0) return false;
  return relevant.every(
    (f) =>
      f.displayStatus !== "DELIVERED" &&
      f.events.nodes.every((e) => NO_SCAN_STATUSES.has(e.status)),
  );
}

/**
 * The newest event of a parcel the carrier has scanned but not delivered,
 * when that event is STALLED_AFTER_DAYS old or more; otherwise null. With
 * several of our fulfillments, the one silent the longest is returned.
 */
export function stalledEvent(
  fulfillments: Fulfillment[],
  ours: { fulfillmentIds: string[]; trackingNumbers: string[] },
  now: Date,
): FulfillmentEvent | null {
  const limit = now.getTime() - STALLED_AFTER_DAYS * DAY_MS;
  const stalled = ourFulfillments(fulfillments, ours)
    .filter((f) => f.displayStatus !== "DELIVERED")
    .filter((f) => f.events.nodes.some((e) => !NO_SCAN_STATUSES.has(e.status)))
    .map(newestEvent)
    .filter((e): e is FulfillmentEvent => !!e && e.status !== "DELIVERED" && Date.parse(e.happenedAt) <= limit)
    .sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));
  return stalled[0] || null;
}

export interface StuckShipment {
  /** no_scan: FedEx never scanned it. stalled: scanned, then silent for days. */
  kind: "no_scan" | "stalled";
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
  /** When the newest event happened, and FedEx's text for it. */
  lastEventAt: Date | null;
  lastMessage: string | null;
}

export interface StuckCheck {
  stuck: StuckShipment[];
  errors: { order: string; detail: string }[];
  checked: number;
}

/**
 * Every booked order, shipped 2–45 days ago, not delivered or checked, that
 * has no carrier scan or whose carrier events stopped 5+ days ago.
 */
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
      let kind: StuckShipment["kind"];
      let lastEvent: FulfillmentEvent | undefined;
      if (hasNoCarrierScan(fulfillments, ours)) {
        kind = "no_scan";
        lastEvent = ourFulfillments(fulfillments, ours)
          .flatMap((f) => f.events.nodes)
          .sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))[0];
      } else {
        const stalled = stalledEvent(fulfillments, ours, now);
        if (!stalled) continue;
        kind = "stalled";
        lastEvent = stalled;
      }
      const address = (sheet.shippingAddress as Record<string, string | null> | null) || {};
      result.stuck.push({
        kind,
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
        lastEventAt: lastEvent ? new Date(lastEvent.happenedAt) : null,
        lastMessage: lastEvent?.message?.trim() || null,
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

/** BWS courier support, who chase FedEx for us (override with BWS_SUPPORT_EMAIL). */
const bwsSupportEmail = () => process.env.BWS_SUPPORT_EMAIL || "couriersweden@bws.dk";

/** A ready email to BWS asking what happened to a parcel that went quiet. */
function bwsMailto(s: StuckShipment): string {
  const subject = `Order ${s.order}${s.trackingNumber ? ` – ${s.trackingNumber}` : ""} – no FedEx update`;
  const body =
    `Hi,\n\nThe parcel for order ${s.order}` +
    (s.trackingNumber ? ` (tracking ${s.trackingNumber})` : "") +
    (s.city ? ` to ${s.city}` : "") +
    ` has had no new FedEx scan since ${s.lastEventAt ? day(s.lastEventAt) : "a long time"}` +
    (s.lastMessage ? ` ("${s.lastMessage}")` : "") +
    `. Could you check with FedEx where it is and whether we need to do anything?\n\nThank you!`;
  return `mailto:${bwsSupportEmail()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function digestRow(s: StuckShipment, now: Date) {
  const days = Math.floor((now.getTime() - s.shippedAt.getTime()) / DAY_MS);
  const silentDays = s.lastEventAt ? Math.floor((now.getTime() - s.lastEventAt.getTime()) / DAY_MS) : null;
  const ask = s.kind === "stalled" ? bwsMailto(s) : printShopMailto(s);
  const links = [
    `<a href="${esc(adminOrderUrl(s))}">Ordern</a>`,
    s.trackingUrl ? `<a href="${esc(s.trackingUrl)}">Spårning</a>` : null,
    ask ? `<a href="${esc(ask)}">${s.kind === "stalled" ? "Fråga BWS" : "Fråga tryckeriet"}</a>` : null,
  ].filter(Boolean);
  const when =
    s.kind === "stalled" && s.lastEventAt
      ? `senast ${esc(day(s.lastEventAt))} · <b>${silentDays} dagar tyst</b>`
      : `bokad ${esc(day(s.shippedAt))} · <b>${days} dagar</b>`;
  const lastText =
    s.kind === "stalled"
      ? `<div style="color:#555;font-size:13px;">${esc(s.lastStatus || "")}${s.lastMessage ? `: ${esc(s.lastMessage)}` : ""}</div>`
      : "";
  return {
    html:
      `<tr>` +
      `<td style="padding:8px 12px 8px 0;font-weight:700;white-space:nowrap;vertical-align:top;">${esc(s.order)}</td>` +
      `<td style="padding:8px 12px 8px 0;vertical-align:top;">${esc(s.customerName || "")}${s.city ? `, ${esc(s.city)}` : ""}${lastText}</td>` +
      `<td style="padding:8px 12px 8px 0;white-space:nowrap;vertical-align:top;">${when}</td>` +
      `<td style="padding:8px 12px 8px 0;white-space:nowrap;vertical-align:top;">${esc(s.trackingNumber || "–")}</td>` +
      `<td style="padding:8px 0;white-space:nowrap;vertical-align:top;">${links.join(" · ")}</td>` +
      `</tr>`,
    text:
      `${s.order} – ${s.customerName || ""}${s.city ? `, ${s.city}` : ""} – ` +
      (s.kind === "stalled" && s.lastEventAt
        ? `senaste händelse ${day(s.lastEventAt)} (${silentDays} dagar tyst): ${s.lastStatus || ""}${s.lastMessage ? ` – ${s.lastMessage}` : ""}`
        : `bokad ${day(s.shippedAt)} (${days} dagar) – senaste status: ${s.lastStatus || "inga händelser"}`) +
      ` – ${s.trackingNumber || "ingen spårning"}\n` +
      `  Order: ${adminOrderUrl(s)}${s.trackingUrl ? `\n  Spårning: ${s.trackingUrl}` : ""}`,
  };
}

export function stuckShipmentsMail(check: StuckCheck, now: Date) {
  const n = check.stuck.length;
  const subject = `Paket att kolla: ${n} ${n === 1 ? "order" : "ordrar"} (${check.stuck.map((s) => s.order).join(", ")})`;

  const sections = [
    {
      items: check.stuck.filter((s) => s.kind === "no_scan"),
      heading: "Ingen skanning från FedEx",
      intro:
        `Bokades för minst ${STUCK_AFTER_DAYS} dagar sedan men har bara "Shipment information sent to FedEx". ` +
        `De kan ligga kvar hos tryckeriet eller ha missats vid upphämtningen.`,
    },
    {
      items: check.stuck.filter((s) => s.kind === "stalled"),
      heading: "Står still hos FedEx",
      intro:
        `FedEx har skannat paketet men inget nytt har hänt på minst ${STALLED_AFTER_DAYS} dagar, och det är inte levererat. ` +
        `Fråga BWS vad som hänt, och kolla med kunden om paketet kommit fram.`,
    },
  ].filter((sec) => sec.items.length);

  const errorNote = check.errors.length
    ? `Kunde inte kolla: ${check.errors.map((e) => `${e.order} (${e.detail})`).join("; ")}`
    : "";
  const outro =
    `När en order är utredd: tryck "Checked – stop reminding" på orderns fraktkort i appen, ` +
    `annars kommer den med i det här mejlet varje vardagsmorgon.`;

  const html = `<!doctype html><html lang="sv"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#111;">
${sections
  .map(
    (sec) =>
      `<h3 style="margin:18px 0 4px;font-size:15px;">${esc(sec.heading)} (${sec.items.length})</h3>
<p style="margin:0 0 6px;color:#333;">${esc(sec.intro)}</p>
<table style="border-collapse:collapse;font-size:14px;">${sec.items.map((s) => digestRow(s, now).html).join("")}</table>`,
  )
  .join("\n")}
<p style="color:#555;margin-top:18px;">${esc(outro)}</p>
${errorNote ? `<p style="color:#b00;">${esc(errorNote)}</p>` : ""}
</body></html>`;
  const text = [
    ...sections.flatMap((sec) => [
      `${sec.heading.toUpperCase()} (${sec.items.length})`,
      sec.intro,
      "",
      ...sec.items.map((s) => digestRow(s, now).text),
      "",
    ]),
    outro,
    errorNote,
  ]
    .join("\n")
    .trim();
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

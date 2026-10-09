import type { GangSheet } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendMail, mailFrom } from "./mailer.server";
import { orderLabel } from "./order-status";
import { SIMULATED_PREFIX } from "./bws-shipping.server";
import { trackingUrlFor } from "./order-shipment.server";

/**
 * Missed delivery: when the carrier (FedEx, through BWS) reports a failed
 * delivery attempt, the customer gets an email the next morning telling them
 * to rebook with the carrier or answer us — so nobody has to watch the
 * tracking and write to them by hand.
 *
 * Shopify follows the tracking numbers and records the carrier's steps as
 * fulfillment events. Shopify Flow cannot email customers on the Basic plan,
 * so the worker sweeps the shipped orders every hour instead:
 *   - delivered → noted on the order, never checked again
 *   - an attempt and still not delivered at 08:00 (Stockholm) the day after
 *     → one email, and the Shopify order is tagged
 * Delivered before the morning means no email. Max one per order.
 */

const TIMEZONE = "Europe/Stockholm";
/** The email goes out at this hour the day after the attempt. */
const SEND_HOUR = 8;
/** After this long past the send time it is too late to write (e.g. the worker was down). */
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Orders shipped longer ago than this are no longer followed. */
const FOLLOW_DAYS = 21;
export const MISSED_DELIVERY_TAG = "leveransforsok-mejlad";

const DAY_MS = 24 * 60 * 60 * 1000;

const ORDER_QUERY = `#graphql
  query OrderDeliveryEvents($id: ID!) {
    order(id: $id) {
      id
      email
      fulfillments(first: 10) {
        id
        displayStatus
        trackingInfo(first: 5) {
          number
          url
        }
        events(first: 20, sortKey: HAPPENED_AT, reverse: true) {
          nodes {
            status
            happenedAt
          }
        }
      }
    }
  }
`;

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export interface ShopifyFulfillment {
  id: string;
  displayStatus: string | null;
  trackingInfo: { number: string | null; url: string | null }[];
  /** Newest first. */
  events: { nodes: { status: string; happenedAt: string }[] };
}

export type DeliveryDecision =
  | { action: "delivered"; deliveredAt: Date }
  | { action: "send"; attemptAt: Date; trackingNumber: string | null; trackingUrl: string | null }
  | { action: "wait"; attemptAt: Date; sendAt: Date }
  | { action: "too-late"; attemptAt: Date }
  | { action: "none" };

/* ── Stockholm time ───────────────────────────────────────────────────── */

/** "2026-10-09" for the Stockholm calendar day of an instant. */
function stockholmDay(at: Date): string {
  return at.toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T12:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Stockholm's offset from UTC in minutes at an instant (60 in winter, 120 in summer). */
function stockholmOffset(at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}

/** The instant it is `hour`:00 in Stockholm on a calendar day. */
function stockholmHour(day: string, hour: number): Date {
  const asUtc = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  return new Date(asUtc.getTime() - stockholmOffset(asUtc) * 60 * 1000);
}

/** When the email for an attempt goes out: 08:00 the next day. */
export function sendTimeFor(attemptAt: Date): Date {
  return stockholmHour(addDays(stockholmDay(attemptAt), 1), SEND_HOUR);
}

/* ── Decision ─────────────────────────────────────────────────────────── */

const cleanNumber = (n: string | null | undefined) => (n || "").replace(/\s+/g, "");

/**
 * What to do for one order, from its fulfillments in Shopify. Only the
 * fulfillments the app shipped count — presses and blanks go their own way.
 */
export function decide(
  fulfillments: ShopifyFulfillment[],
  ours: { fulfillmentIds: string[]; trackingNumbers: string[] },
  now: Date,
): DeliveryDecision {
  const ids = new Set(ours.fulfillmentIds);
  const numbers = new Set(ours.trackingNumbers.map(cleanNumber).filter(Boolean));
  const relevant = fulfillments.filter(
    (f) => ids.has(f.id) || f.trackingInfo.some((t) => numbers.has(cleanNumber(t.number))),
  );
  if (relevant.length === 0) return { action: "none" };

  let attempt: { at: Date; fulfillment: ShopifyFulfillment } | null = null;
  let deliveredAt: Date | null = null;
  let allDelivered = true;

  for (const f of relevant) {
    const events = f.events.nodes;
    const lastAttempt = events.findIndex((e) => e.status === "ATTEMPTED_DELIVERY");
    const delivered = events.find((e) => e.status === "DELIVERED");
    // Events are newest first: a DELIVERED before the attempt's index came after it.
    const deliveredSinceAttempt =
      f.displayStatus === "DELIVERED" ||
      (lastAttempt >= 0
        ? events.slice(0, lastAttempt).some((e) => e.status === "DELIVERED")
        : Boolean(delivered));

    if (deliveredSinceAttempt) {
      const at = delivered ? new Date(delivered.happenedAt) : now;
      if (!deliveredAt || at > deliveredAt) deliveredAt = at;
      continue;
    }
    allDelivered = false;
    if (lastAttempt >= 0) {
      const at = new Date(events[lastAttempt].happenedAt);
      if (!attempt || at > attempt.at) attempt = { at, fulfillment: f };
    }
  }

  if (allDelivered) return { action: "delivered", deliveredAt: deliveredAt || now };
  if (!attempt) return { action: "none" };

  const sendAt = sendTimeFor(attempt.at);
  if (now < sendAt) return { action: "wait", attemptAt: attempt.at, sendAt };
  if (now.getTime() - sendAt.getTime() > SEND_WINDOW_MS) return { action: "too-late", attemptAt: attempt.at };

  const tracking =
    attempt.fulfillment.trackingInfo.find((t) => numbers.has(cleanNumber(t.number))) ||
    attempt.fulfillment.trackingInfo[0];
  return {
    action: "send",
    attemptAt: attempt.at,
    trackingNumber: tracking ? cleanNumber(tracking.number) || null : null,
    trackingUrl: tracking?.url || null,
  };
}

/* ── Sweep ────────────────────────────────────────────────────────────── */

export interface SweepResult {
  order: string;
  action: DeliveryDecision["action"] | "error";
  detail?: string;
}

/**
 * Check every order shipped in the last three weeks that is neither
 * delivered nor already emailed. `dryRun` only reports what would happen.
 */
export async function sweepMissedDeliveries(
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<SweepResult[]> {
  const now = options.now || new Date();
  const sheets = await prisma.gangSheet.findMany({
    where: {
      shopifyOrderId: { not: null },
      shippedAt: { gte: new Date(now.getTime() - FOLLOW_DAYS * DAY_MS) },
      deliveredAt: null,
      missedDeliveryMailSentAt: null,
      OR: [{ shopifyFulfillmentId: { not: null } }, { trackingNumber: { not: null } }],
    },
    orderBy: { createdAt: "asc" },
  });

  // The shipping fields are the same on every job of an order: one per order.
  const orders = new Map<string, GangSheet>();
  for (const s of sheets) {
    const key = `${s.shopDomain}|${s.shopifyOrderId}`;
    if (!orders.has(key)) orders.set(key, s);
  }

  const results: SweepResult[] = [];
  for (const sheet of orders.values()) {
    if (sheet.trackingNumber?.startsWith(SIMULATED_PREFIX)) continue;
    const order = orderLabel(sheet);
    try {
      results.push(await checkOrder(sheet, now, Boolean(options.dryRun)));
    } catch (error) {
      results.push({ order, action: "error", detail: (error as Error).message.slice(0, 300) });
    }
  }
  return results;
}

async function checkOrder(sheet: GangSheet, now: Date, dryRun: boolean): Promise<SweepResult> {
  const order = orderLabel(sheet);
  const where = { shopDomain: sheet.shopDomain, shopifyOrderId: sheet.shopifyOrderId! };
  const orderGid = `gid://shopify/Order/${sheet.shopifyOrderId}`;

  const { admin } = await unauthenticated.admin(sheet.shopDomain);
  const res = await admin.graphql(ORDER_QUERY, { variables: { id: orderGid } });
  const body: any = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  const shopifyOrder = body.data?.order;
  if (!shopifyOrder) return { order, action: "none", detail: "order not found in Shopify" };

  const decision = decide(
    shopifyOrder.fulfillments || [],
    {
      fulfillmentIds: (sheet.shopifyFulfillmentId || "").split(",").filter(Boolean),
      trackingNumbers: (sheet.trackingNumber || "").split(","),
    },
    now,
  );

  if (decision.action === "delivered") {
    if (!dryRun) {
      await prisma.gangSheet.updateMany({ where, data: { deliveredAt: decision.deliveredAt } });
    }
    return { order, action: "delivered", detail: decision.deliveredAt.toISOString() };
  }
  if (decision.action === "wait") {
    return { order, action: "wait", detail: `attempt ${decision.attemptAt.toISOString()}, email ${decision.sendAt.toISOString()}` };
  }
  if (decision.action === "too-late") {
    return { order, action: "too-late", detail: `attempt ${decision.attemptAt.toISOString()}` };
  }
  if (decision.action === "none") return { order, action: "none" };

  const address = (sheet.shippingAddress as Record<string, string | null> | null) || {};
  const to = address.email || shopifyOrder.email;
  if (!to) return { order, action: "error", detail: "no customer email on the order" };

  const mail = missedDeliveryMail({
    orderName: order,
    customerName: sheet.customerName,
    attemptAt: decision.attemptAt,
    now,
    trackingNumber: decision.trackingNumber || cleanNumber(sheet.trackingNumber?.split(",")[0]),
    trackingUrl:
      decision.trackingUrl ||
      sheet.trackingUrl ||
      (decision.trackingNumber ? trackingUrlFor(decision.trackingNumber) : null),
    address,
  });
  if (dryRun) return { order, action: "send", detail: `would email: ${mail.subject}` };

  // Claim first, so a second worker or a slow sweep cannot send it twice.
  const claimed = await prisma.gangSheet.updateMany({
    where: { ...where, missedDeliveryMailSentAt: null },
    data: { missedDeliveryMailSentAt: now },
  });
  if (claimed.count === 0) return { order, action: "none", detail: "already emailed" };

  try {
    await sendMail({
      to,
      from: process.env.CUSTOMER_MAIL_FROM || mailFrom(),
      replyTo: process.env.CUSTOMER_REPLY_TO || undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // Not sent: free the claim so the next sweep tries again.
    await prisma.gangSheet.updateMany({ where, data: { missedDeliveryMailSentAt: null } });
    throw error;
  }

  // The tag shows it in the Shopify admin; the email is out either way.
  const tagRes = await admin
    .graphql(TAG_MUTATION, { variables: { id: orderGid, tags: [MISSED_DELIVERY_TAG] } })
    .then((r) => r.json() as Promise<any>)
    .catch((error: Error) => ({ errors: error.message }));
  const tagError = tagRes.errors || tagRes.data?.tagsAdd?.userErrors?.[0]?.message;
  return { order, action: "send", detail: tagError ? `emailed; tag failed: ${JSON.stringify(tagError).slice(0, 200)}` : "emailed" };
}

/* ── Email (Swedish, the Shopify notifications' design) ───────────────── */

const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const RED = "#DC2F3C";
const LOGO = "https://cdn.shopify.com/s/files/1/0988/4359/1030/files/transfercraft-logo-email.png";
const LOGO_LIGHT = "https://cdn.shopify.com/s/files/1/0988/4359/1030/files/transfercraft-logo-email-light.png";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The carrier's name from its tracking link or number; BWS hands parcels to FedEx. */
export function carrierName(trackingUrl: string | null, trackingNumber: string | null): string | null {
  const url = trackingUrl || (trackingNumber ? trackingUrlFor(trackingNumber) : null) || "";
  if (/fedex\./i.test(url)) return "FedEx";
  if (/ups\./i.test(url)) return "UPS";
  if (/dhl\./i.test(url)) return "DHL";
  return null;
}

export interface MissedDeliveryMailInput {
  orderName: string;
  customerName: string | null;
  attemptAt: Date;
  now: Date;
  trackingNumber: string | null;
  trackingUrl: string | null;
  address: Record<string, string | null>;
}

export function missedDeliveryMail(input: MissedDeliveryMailInput) {
  const { orderName, trackingNumber, trackingUrl, address } = input;
  const carrier = carrierName(trackingUrl, trackingNumber);
  const Carrier = carrier || "Budfirman";
  const carrierLower = carrier || "budfirman";
  const firstName = (input.customerName || "").trim().split(/\s+/)[0];

  const attemptDay = stockholmDay(input.attemptAt);
  const dateText = input.attemptAt.toLocaleDateString("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TIMEZONE,
  });
  const when = attemptDay === addDays(stockholmDay(input.now), -1) ? `i går, ${dateText}` : dateText;

  const headline = `${Carrier} kunde inte lämna ditt paket`;
  const lead =
    `${firstName ? `Hej ${firstName}! ` : ""}${Carrier} försökte leverera paketet från order ${orderName} ${when}, ` +
    `men kunde inte lämna det. Paketet finns kvar hos ${carrierLower}. Boka en ny leverans så kommer det fram.`;
  const button = carrier ? `Boka ny leverans hos ${carrier}` : "Spåra och boka ny leverans";
  const step1 =
    `Öppna spårningen med knappen ovan. Där ser du vad som händer härnäst och kan boka en ny leverans.` +
    (carrier === "FedEx" ? " Har du fått en lapp i dörren kan du också använda numret på den (det börjar med DT)." : "");
  const step1Text = trackingUrl ? step1 : `Kontakta ${carrierLower} med spårningsnumret nedan och boka en ny leverans.`;
  const step2 = "Svara på det här mejlet så hjälper vi dig att få paketet levererat.";
  const outro = "Stämmer inte adressen? Svara på mejlet så rättar vi den. Har du redan fått paketet kan du bortse från det här mejlet.";

  const addressLines = [
    address.name,
    address.company,
    address.address1,
    address.address2,
    [address.zip, address.city].filter(Boolean).join(" "),
    address.countryCode && address.countryCode !== "SE" ? address.country : null,
  ].filter((l): l is string => Boolean(l && l.trim()));

  const td = `font-family:${FONT};`;
  const label = `font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#111111;padding-bottom:6px;`;

  const html = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(headline)}</title>
<style>
body{margin:0;padding:0;background:#f4f3f1;-webkit-text-size-adjust:100%;}
@media (max-width:620px){.wrap{width:100% !important;}.pad{padding-left:24px !important;padding-right:24px !important;}.help-cell{padding:28px 24px !important;}.h1{font-size:27px !important;}.stack{display:block !important;width:auto !important;}}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f3f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(Carrier)} kunde inte lämna ditt paket. Så här får du det levererat.</div>
<table role="presentation" width="100%" bgcolor="#f4f3f1" cellpadding="0" cellspacing="0" style="background:#f4f3f1;border-collapse:collapse;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;border-collapse:collapse;">

<tr><td style="padding:0 8px 20px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><a href="https://transfercraft.com"><img src="${LOGO}" width="150" alt="Transfercraft" style="display:block;border:0;width:150px;height:auto;"></a></td>
    <td style="${td}font-size:13px;color:#6b6b6b;text-align:right;">Order ${esc(orderName)}</td>
  </tr></table>
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:14px;${td}color:#333333;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td class="pad" style="${td}padding:40px 40px 0;"><span style="display:inline-block;background:#fdecee;color:#c5303c;font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;padding:6px 12px;border-radius:100px;">Leveransförsök</span></td></tr>
    <tr><td class="pad h1" style="${td}padding:16px 40px 0;font-size:32px;line-height:1.12;font-weight:700;letter-spacing:-0.8px;color:#000000;">${esc(headline)}</td></tr>
    <tr><td class="pad" style="${td}padding:16px 40px 0;font-size:15px;line-height:1.6;color:#333333;">${esc(lead)}</td></tr>
    ${
      trackingUrl
        ? `<tr><td class="pad" style="padding:28px 40px 36px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${RED}" style="background:${RED};border-radius:14px;"><a href="${esc(trackingUrl)}" style="${td}display:inline-block;padding:15px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:14px;white-space:nowrap;">${esc(button)}</a></td>
      </tr></table>
    </td></tr>`
        : `<tr><td style="padding-bottom:36px;"></td></tr>`
    }
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="${td}padding:0 40px 36px;">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.3px;color:#000000;padding-bottom:12px;">Så får du ditt paket</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f3f1" style="background:#f4f3f1;border-radius:14px;">
      <tr><td style="${td}padding:20px 20px 8px;vertical-align:top;width:28px;font-size:14px;font-weight:700;color:${RED};">1</td>
          <td style="${td}padding:20px 20px 8px 0;font-size:14px;line-height:1.6;color:#333333;"><strong style="color:#111111;">Boka om hos ${esc(carrierLower)}.</strong> ${esc(step1Text)}</td></tr>
      <tr><td style="${td}padding:8px 20px 20px;vertical-align:top;width:28px;font-size:14px;font-weight:700;color:${RED};">2</td>
          <td style="${td}padding:8px 20px 20px 0;font-size:14px;line-height:1.6;color:#333333;"><strong style="color:#111111;">Eller hör av dig till oss.</strong> ${esc(step2)}</td></tr>
    </table>
  </td></tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="${td}padding:0 40px 36px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ececec;"><tr>
      ${
        trackingNumber
          ? `<td class="stack" width="50%" style="${td}padding-top:24px;vertical-align:top;font-size:14px;line-height:1.6;color:#333333;">
        <div style="${label}">Spårningsnummer</div>
        ${trackingUrl ? `<a href="${esc(trackingUrl)}" style="color:${RED};">${esc(trackingNumber)}</a>` : esc(trackingNumber)}${carrier ? `<br><span style="color:#8a8a8a;">${esc(carrier)}</span>` : ""}
      </td>`
          : ""
      }
      ${
        addressLines.length
          ? `<td class="stack" style="${td}padding-top:24px;vertical-align:top;font-size:14px;line-height:1.6;color:#333333;">
        <div style="${label}">Leveransadress</div>
        ${addressLines.map(esc).join("<br>")}
      </td>`
          : ""
      }
    </tr></table>
    <div style="padding-top:20px;font-size:14px;line-height:1.6;color:#666666;">${esc(outro)}</div>
  </td></tr></table>
</td></tr>

<tr><td style="padding-top:12px;">
  <table role="presentation" width="100%" bgcolor="#111111" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:14px;">
    <tr><td class="help-cell" style="${td}padding:32px 40px;">
      <img src="${LOGO_LIGHT}" width="130" alt="Transfercraft" style="display:block;border:0;width:130px;height:auto;">
      <div style="font-size:14px;line-height:1.6;color:#b3b3b3;padding-top:10px;">Frågor? Svara på det här mejlet eller hör av dig, vi finns här mån-fre 09:00-17:00.</div>
      <div style="font-size:14px;padding-top:14px;color:#666666;"><a href="mailto:info@transfercraft.com" style="color:#ffffff;text-decoration:none;font-weight:500;">info@transfercraft.com</a> &nbsp;&middot;&nbsp; <a href="tel:+46704411710" style="color:#ffffff;text-decoration:none;font-weight:500;">070-441 17 10</a></div>
    </td></tr>
  </table>
</td></tr>

<tr><td style="${td}padding:20px 8px 0;font-size:12px;line-height:1.6;color:#8a8a8a;text-align:center;">&copy; ${input.now.getFullYear()} Transfercraft &middot; <a href="https://transfercraft.com" style="color:#8a8a8a;">transfercraft.com</a></td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `Order ${orderName}: ${headline}`,
    "",
    lead,
    "",
    "Så får du ditt paket",
    `1. Boka om hos ${carrierLower}. ${step1Text.replace("med knappen ovan", "via länken")}`,
    ...(trackingUrl ? [`   ${trackingUrl}`] : []),
    `2. Eller hör av dig till oss. ${step2}`,
    "",
    ...(trackingNumber ? [`Spårningsnummer: ${trackingNumber}${carrier ? ` (${carrier})` : ""}`] : []),
    ...(addressLines.length ? ["Leveransadress:", ...addressLines] : []),
    "",
    outro,
    "",
    "Frågor? Svara på det här mejlet eller skriv till info@transfercraft.com, 070-441 17 10.",
  ].join("\n");

  return { subject: `Order ${orderName} kunde inte levereras`, html, text };
}

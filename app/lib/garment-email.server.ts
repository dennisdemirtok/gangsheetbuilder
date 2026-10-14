import prisma from "../db.server";
import { PICKUP_TIME, serviceLabel } from "./bws-shipping.server";
import { GARMENT_PICKUP, garmentPieces, itemsBySku, type GarmentItem } from "./garments";
import { sendMail, type MailAttachment } from "./mailer.server";
import { downloadFile } from "./r2.server";

/**
 * The clothes of an order, emailed to Feelgood (Danuta) for dropshipping from
 * Printgood. English, in the same template as the print shop email. Before
 * the pickup is booked it asks them to confirm when the garments are ready;
 * once booked it carries the pickup time and the BWS label.
 */

const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const RED = "#DC2F3C";

function brandImg(): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return `<img src="${base}/brand/tc-wordmark.png" width="150" height="19" alt="Transfercraft" style="display:block;border:0;width:150px;height:auto;">`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pickupDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

type GarmentOrderRow = NonNullable<Awaited<ReturnType<typeof prisma.garmentOrder.findUnique>>>;
type Address = Record<string, string | null | undefined>;

function shipToLines(order: GarmentOrderRow): string[] {
  const a = (order.shippingAddress as Address | null) || {};
  return [
    a.name || order.customerName,
    a.company,
    a.address1,
    a.address2,
    [a.zip, a.city].filter(Boolean).join(" "),
    a.country,
    a.phone,
  ].filter((l): l is string => Boolean(l && String(l).trim()));
}

function mailHtml(order: GarmentOrderRow, message?: string): string {
  const items = itemsBySku(order.items as unknown as GarmentItem[]);
  const pieces = garmentPieces(items);
  const label = order.orderName || `#${order.shopifyOrderId}`;
  const booked = order.shippingStatus === "booked" && order.pickupDate;
  const pickupWhere = `${GARMENT_PICKUP.name}, ${GARMENT_PICKUP.address1}, ${GARMENT_PICKUP.zip} ${GARMENT_PICKUP.city}`;

  const pickup = booked
    ? `
      <tr><td style="padding:20px 32px 0;">
        <div style="background:#f4f3f1;border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.55;color:#111;">
          <div style="font-weight:700;">BWS courier pickup: ${esc(pickupDay(order.pickupDate!))}, from ${PICKUP_TIME}</div>
          <div style="color:#666;">${esc(pickupWhere)}</div>
          <div style="padding-top:8px;">${esc(serviceLabel(order.shippingService))}${order.trackingNumber ? ` · ${esc(order.trackingNumber)}` : ""}</div>
          ${order.shippingLabelKey ? `<div style="padding-top:8px;font-weight:700;color:${RED};">Label attached: please print it and put it on the parcel.</div>` : ""}
        </div>
      </td></tr>`
    : `
      <tr><td style="padding:20px 32px 0;">
        <div style="background:#f4f3f1;border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.55;color:#111;">
          <div style="font-weight:700;">Please let us know when the garments are ready for pickup.</div>
          <div style="color:#666;">We then book a BWS courier to collect the parcel at ${esc(pickupWhere)} and send you the label.</div>
        </div>
      </td></tr>`;

  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:8px 0;border-top:1px solid #e6e4e0;font-family:${FONT};font-size:14px;color:#111;">${esc(i.title)}${i.vendor ? `<div style="color:#8a8a8a;font-size:12px;">${esc(i.vendor)}</div>` : ""}</td>
          <td style="padding:8px 8px;border-top:1px solid #e6e4e0;font-family:${FONT};font-size:14px;color:#111;">${esc(i.variantTitle || "")}</td>
          <td style="padding:8px 8px;border-top:1px solid #e6e4e0;font-family:${FONT};font-size:13px;color:#666;">${esc(i.sku || "")}</td>
          <td style="padding:8px 0;border-top:1px solid #e6e4e0;font-family:${FONT};font-size:16px;font-weight:800;color:#111;text-align:right;">${i.quantity}</td>
        </tr>`,
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f3f1" style="background:#f4f3f1;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">
      <tr><td style="padding:0 8px 16px;">${brandImg()}</td></tr>
      <tr><td bgcolor="#ffffff" style="background:#fff;border-radius:14px;padding-bottom:28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:28px 32px 0;font-family:${FONT};">
            <div style="font-size:20px;font-weight:700;color:#111;">Order ${esc(label)} · ${pieces} ${pieces === 1 ? "garment" : "garments"}</div>
            <div style="font-size:14px;color:#666;padding-top:2px;">Dropshipping from Printgood for Transfercraft</div>
          </td></tr>
          ${message ? `<tr><td style="padding:16px 32px 0;font-family:${FONT};font-size:14px;line-height:1.55;color:#111;white-space:pre-wrap;"><b>Message:</b><br>${esc(message)}</td></tr>` : ""}
          ${pickup}
          <tr><td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.4px;">Garment</td>
                <td style="padding:0 8px 6px;font-family:${FONT};font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.4px;">Colour / size</td>
                <td style="padding:0 8px 6px;font-family:${FONT};font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.4px;">SKU</td>
                <td style="padding:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.4px;text-align:right;">Qty</td>
              </tr>
              ${rows}
              <tr>
                <td colspan="3" style="padding:10px 0 0;border-top:2px solid #111;font-family:${FONT};font-size:14px;font-weight:700;color:#111;">Total</td>
                <td style="padding:10px 0 0;border-top:2px solid #111;font-family:${FONT};font-size:16px;font-weight:800;color:#111;text-align:right;">${pieces}</td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding:20px 32px 0;font-family:${FONT};font-size:13px;line-height:1.55;color:#666;">
            <b style="color:#111;">Ship to:</b> ${esc(shipToLines(order).join(", "))}
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:14px 8px 0;font-family:${FONT};font-size:12px;color:#8a8a8a;">Transfercraft · dennis@transfercraft.com</td></tr>
    </table>
  </td></tr>
</table>`;
}

function mailText(order: GarmentOrderRow, message?: string): string {
  const items = itemsBySku(order.items as unknown as GarmentItem[]);
  const label = order.orderName || `#${order.shopifyOrderId}`;
  const booked = order.shippingStatus === "booked" && order.pickupDate;
  return [
    `Order ${label}: ${garmentPieces(items)} garments, dropshipping from Printgood`,
    "",
    ...(message ? [`Message: ${message}`, ""] : []),
    booked
      ? `BWS courier pickup: ${order.pickupDate} from ${PICKUP_TIME} at Printgood, ${GARMENT_PICKUP.city}${order.shippingLabelKey ? ". Label attached: please print it and put it on the parcel." : "."}`
      : "Please let us know when the garments are ready for pickup. We then book the BWS courier and send you the label.",
    "",
    ...items.map((i) => `${i.quantity} x ${i.title} ${i.variantTitle ?? ""} (${i.sku ?? "no SKU"})`),
    "",
    `Ship to: ${shipToLines(order).join(", ")}`,
  ].join("\n");
}

export async function sendGarmentsToSupplier(options: {
  shopDomain: string;
  id: string;
  to: string;
  message?: string;
}): Promise<{ ok: boolean; errors?: string[]; attachedLabel?: boolean }> {
  const order = await prisma.garmentOrder.findFirst({ where: { id: options.id, shopDomain: options.shopDomain } });
  if (!order) return { ok: false, errors: ["Order not found."] };
  const label = order.orderName || `#${order.shopifyOrderId}`;
  const pieces = garmentPieces(order.items as unknown as GarmentItem[]);

  const attachments: MailAttachment[] = [];
  if (order.shippingStatus === "booked" && order.shippingLabelKey) {
    const ext = order.shippingLabelKey.split(".").pop() || "pdf";
    attachments.push({
      filename: `${label.replace(/^#/, "")}_garments_BWS_label.${ext}`,
      content: await downloadFile(order.shippingLabelKey),
    });
  }

  const message = options.message?.trim() || undefined;
  try {
    await sendMail({
      to: options.to,
      subject: `Order ${label} · ${pieces} garments · Transfercraft`,
      html: mailHtml(order, message),
      text: mailText(order, message),
      // Danuta's "ready for pickup" goes to the shop, not to a no-reply address.
      replyTo: process.env.GARMENT_REPLY_TO || "dennis@transfercraft.com",
      attachments,
    });
  } catch (error) {
    return { ok: false, errors: [`Email to ${options.to} failed: ${(error as Error).message}`] };
  }

  await prisma.garmentOrder.update({
    where: { id: order.id },
    data: {
      sentToSupplierAt: new Date(),
      sentToSupplierTo: options.to,
      ...(order.status === "new" ? { status: "sent" } : {}),
    },
  });
  return { ok: true, attachedLabel: attachments.length > 0 };
}

/** For a preview on the page, without sending anything. */
export async function previewGarmentMail(shopDomain: string, id: string, message?: string) {
  const order = await prisma.garmentOrder.findFirst({ where: { id, shopDomain } });
  return order ? { html: mailHtml(order, message), text: mailText(order, message) } : null;
}

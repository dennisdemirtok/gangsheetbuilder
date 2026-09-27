import prisma from "../db.server";
import { downloadFile } from "./r2.server";
import { fileLink, linkExpiry } from "./file-links.server";
import { sendMail, mailFrom, type MailAttachment } from "./mailer.server";
import { orderLabel, printFileName } from "./order-status";
import type { LineProperty } from "./print-jobs";
import { PACKAGE_CM, PICKUP_TIME, serviceLabel } from "./bws-shipping.server";

/**
 * Hand an order to the print shop by email, and tell the customer that
 * production has started.
 *
 * The print shop does not log in to the app yet. One email per Shopify order
 * carries everything they need: every print job with size, count and how it
 * is finished, the files, the customer's notes, and the BWS label with the
 * pickup time. Polish first — that is what they read — with English under
 * each line.
 */

/** Gmail refuses messages over 25 MB; base64 adds a third. */
const MAX_ATTACH_BYTES = 17 * 1024 * 1024;

const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const RED = "#DC2F3C";

type Sheet = Awaited<ReturnType<typeof loadOrder>>[number];

function loadOrder(shopDomain: string, shopifyOrderId: string) {
  return prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId },
    orderBy: { createdAt: "asc" },
    include: {
      exports: { orderBy: { createdAt: "desc" }, take: 1 },
      images: { select: { dpiX: true, originalFilename: true }, take: 1 },
    },
  });
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cm(mm: number): string {
  return (mm / 10).toLocaleString("pl-PL", { maximumFractionDigits: 1 });
}

function dateIn(locale: string, date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** Properties the customer typed, minus what the size line already says. */
function customerNotes(sheet: Sheet): LineProperty[] {
  const props = (sheet.lineProperties as LineProperty[] | null) || [];
  return props.filter((p) => !/bredd|höjd|hojd|width|height/i.test(p.name));
}

interface JobFile {
  sheet: Sheet;
  filename: string;
  key: string | null;
  bytes: number;
  link: string | null;
}

function jobFiles(sheets: Sheet[]): JobFile[] {
  const used = new Set<string>();
  return sheets.map((sheet) => {
    const file = sheet.exports[0];
    let filename = file ? printFileName(sheet, file.format) : "";
    // Two jobs of the same size and count would otherwise share a name.
    for (let i = 2; filename && used.has(filename); i++) {
      filename = filename.replace(/(\.[^.]+)$/, `_${i}$1`);
    }
    used.add(filename);
    return {
      sheet,
      filename,
      key: file?.url ?? null,
      bytes: file?.fileSizeBytes ?? 0,
      link: file ? fileLink(file.url, filename) : null,
    };
  });
}

/* ── Print shop email (Polish + English) ─────────────────────────────── */

function jobHeading(sheet: Sheet): { pl: string; en: string } {
  const qty = sheet.lineQuantity || 1;
  const size = `${cm(sheet.widthMm)} × ${cm(sheet.heightMm)} cm`;
  if (sheet.kind === "cut") {
    return {
      pl: `${qty} szt. · ${size} · wyciąć każdy motyw`,
      en: `${qty} pcs · ${size} · cut out each design`,
    };
  }
  return {
    pl: `Arkusz na rolce ${size}${qty > 1 ? ` · ${qty} kopie` : ""} · drukować w całości`,
    en: `Gang sheet on roll ${size}${qty > 1 ? ` · ${qty} copies` : ""} · print as is`,
  };
}

interface PrintShopMailInput {
  sheets: Sheet[];
  files: JobFile[];
  attachFiles: boolean;
  hasLabel: boolean;
  message?: string;
}

function printShopHtml({ sheets, files, attachFiles, hasLabel, message }: PrintShopMailInput): string {
  const first = sheets[0];
  const order = orderLabel(first);
  const address = (first.shippingAddress as Record<string, string | null> | null) || {};
  const booked = first.shippingStatus === "booked" && first.pickupDate;
  const expires = linkExpiry().toLocaleDateString("pl-PL");

  const pickup = booked
    ? `
      <tr><td style="padding:20px 32px 0;">
        <div style="background:#f4f3f1;border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.55;color:#111;">
          <div style="font-weight:700;">Odbiór kurierem BWS: ${esc(dateIn("pl-PL", first.pickupDate!))}, ${PICKUP_TIME}</div>
          <div style="color:#666;">BWS courier pickup: ${esc(dateIn("en-GB", first.pickupDate!))}, ${PICKUP_TIME}</div>
          <div style="padding-top:8px;">${esc(serviceLabel(first.shippingService))} · DDP · ${PACKAGE_CM.length}×${PACKAGE_CM.width}×${PACKAGE_CM.height} cm${first.trackingNumber ? ` · ${esc(first.trackingNumber)}` : ""}</div>
          ${hasLabel ? `<div style="padding-top:8px;font-weight:700;color:${RED};">Etykieta w załączniku — proszę wydrukować i nakleić na paczkę.</div>
          <div style="color:#666;">Label attached — please print it and put it on the parcel.</div>` : ""}
        </div>
      </td></tr>`
    : `
      <tr><td style="padding:20px 32px 0;font-family:${FONT};font-size:14px;line-height:1.55;color:#333;">
        Wysyłka zostanie zarezerwowana osobno.<br><span style="color:#666;">Shipping will be booked separately.</span>
      </td></tr>`;

  const jobs = files
    .map(({ sheet, filename, link }, i) => {
      const h = jobHeading(sheet);
      const dpi = sheet.kind === "cut" ? sheet.images[0]?.dpiX : null;
      const notes = customerNotes(sheet);
      return `
      <tr><td style="padding:16px 32px 0;">
        <div style="border:1px solid #e6e4e0;border-radius:12px;padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:#111;">
          <div style="font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.4px;">${i + 1}. ${esc(sheet.printType || "DTF Transfer")}${sheet.filmType && sheet.filmType !== "standard" ? ` · ${esc(sheet.filmType)}` : ""}</div>
          <div style="padding-top:4px;font-weight:700;">${esc(h.pl)}</div>
          <div style="color:#666;">${esc(h.en)}</div>
          ${notes.map((n) => `<div style="padding-top:8px;"><span style="color:#666;">Uwagi klienta / Customer note (${esc(n.name)}):</span> ${esc(n.value)}</div>`).join("")}
          ${
            link
              ? `<div style="padding-top:10px;"><a href="${esc(link)}" style="color:${RED};font-weight:700;">Pobierz plik / Download file</a> <span style="color:#8a8a8a;">${esc(filename)}${dpi ? ` · ${dpi} DPI` : ""}${attachFiles ? " · w załączniku / attached" : ""}</span></div>`
              : `<div style="padding-top:10px;color:${RED};font-weight:700;">Brak pliku — skontaktujemy się. / No file — we will follow up.</div>`
          }
        </div>
      </td></tr>`;
    })
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f3f1" style="background:#f4f3f1;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">
      <tr><td style="padding:0 8px 14px;font-family:${FONT};font-size:18px;font-weight:800;color:#111;">Transfer<span style="color:${RED};">craft</span></td></tr>
      <tr><td bgcolor="#ffffff" style="background:#fff;border-radius:14px;padding-bottom:28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:28px 32px 0;font-family:${FONT};">
            <div style="font-size:20px;font-weight:700;color:#111;">Zamówienie ${esc(order)} — ${files.length} ${files.length === 1 ? "pozycja" : files.length < 5 ? "pozycje" : "pozycji"}</div>
            <div style="font-size:14px;color:#666;padding-top:2px;">Order ${esc(order)} — ${files.length} ${files.length === 1 ? "item" : "items"}</div>
          </td></tr>
          ${message ? `<tr><td style="padding:16px 32px 0;font-family:${FONT};font-size:14px;line-height:1.55;color:#111;white-space:pre-wrap;"><b>Wiadomość / Message:</b><br>${esc(message)}</td></tr>` : ""}
          ${pickup}
          ${jobs}
          <tr><td style="padding:20px 32px 0;font-family:${FONT};font-size:13px;line-height:1.55;color:#666;">
            <b style="color:#111;">Odbiorca / Recipient:</b> ${esc([address.name, address.city, address.country].filter(Boolean).join(", ") || first.customerName || "—")}<br>
            Linki do pobrania ważne do ${esc(expires)}. / Download links valid until ${esc(expires)}.
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:14px 8px 0;font-family:${FONT};font-size:12px;color:#8a8a8a;">Transfercraft · dennis@transfercraft.com</td></tr>
    </table>
  </td></tr>
</table>`;
}

function printShopText({ sheets, files, hasLabel, message }: PrintShopMailInput): string {
  const first = sheets[0];
  const lines = [
    `Zamówienie / Order ${orderLabel(first)}`,
    "",
    ...(message ? [`Wiadomość / Message: ${message}`, ""] : []),
    first.shippingStatus === "booked" && first.pickupDate
      ? `Odbiór kurierem BWS / BWS courier pickup: ${first.pickupDate} ${PICKUP_TIME} · ${serviceLabel(first.shippingService)}${hasLabel ? " · etykieta w załączniku / label attached" : ""}`
      : "Wysyłka zostanie zarezerwowana osobno / Shipping will be booked separately.",
    "",
    ...files.flatMap(({ sheet, filename, link }, i) => {
      const h = jobHeading(sheet);
      return [
        `${i + 1}. ${sheet.printType || "DTF Transfer"}: ${h.pl} / ${h.en}`,
        ...customerNotes(sheet).map((n) => `   Uwagi / Note (${n.name}): ${n.value}`),
        link ? `   ${filename}: ${link}` : "   Brak pliku / No file",
      ];
    }),
  ];
  return lines.join("\n");
}

export interface SendToPrintShopResult {
  ok: boolean;
  errors?: string[];
  attachedFiles?: boolean;
  customerNotified?: boolean;
}

export async function sendOrderToPrintShop(options: {
  shopDomain: string;
  shopifyOrderId: string;
  to: string;
  message?: string;
  notifyCustomer?: boolean;
}): Promise<SendToPrintShopResult> {
  const sheets = await loadOrder(options.shopDomain, options.shopifyOrderId);
  if (sheets.length === 0) return { ok: false, errors: ["No print jobs on this order."] };
  const first = sheets[0];

  const files = jobFiles(sheets);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const attachFiles = total > 0 && total <= MAX_ATTACH_BYTES;

  const attachments: MailAttachment[] = [];
  const labelKey = first.shippingStatus === "booked" ? first.shippingLabelKey : null;
  if (labelKey) {
    const ext = labelKey.split(".").pop() || "pdf";
    attachments.push({
      filename: `${orderLabel(first).replace(/^#/, "")}_BWS_label.${ext}`,
      content: await downloadFile(labelKey),
    });
  }
  if (attachFiles) {
    for (const f of files) {
      if (f.key) attachments.push({ filename: f.filename, content: await downloadFile(f.key) });
    }
  }

  const input = { sheets, files, attachFiles, hasLabel: Boolean(labelKey), message: options.message?.trim() };
  const order = orderLabel(first);
  try {
    await sendMail({
      to: options.to,
      subject: `Zamówienie ${order} / Order ${order} — Transfercraft`,
      html: printShopHtml(input),
      text: printShopText(input),
      attachments,
    });
  } catch (error) {
    return { ok: false, errors: [`Email to the print shop failed: ${(error as Error).message}`] };
  }

  const where = { shopDomain: options.shopDomain, shopifyOrderId: options.shopifyOrderId };
  await prisma.gangSheet.updateMany({
    where,
    data: { sentToPrintShopAt: new Date(), sentToPrintShopTo: options.to },
  });
  // The files are with the print shop now: that is the "downloaded" step.
  await prisma.gangSheet.updateMany({
    where: { ...where, status: "exported" },
    data: { status: "downloaded" },
  });

  let customerNotified = false;
  if (options.notifyCustomer && !first.productionMailSentAt) {
    const result = await sendProductionMail(sheets);
    if (!result.ok) return { ok: true, attachedFiles: attachFiles, errors: [result.error!] };
    customerNotified = true;
  }
  return { ok: true, attachedFiles: attachFiles, customerNotified };
}

/* ── Customer email (Swedish) ─────────────────────────────────────────── */

function productionMail(sheets: Sheet[]) {
  const first = sheets[0];
  const order = orderLabel(first);
  const firstName = (first.customerName || "").trim().split(/\s+/)[0];
  const when =
    first.shippingStatus === "booked" && first.pickupDate
      ? `Den lämnar tryckeriet ${dateIn("sv-SE", first.pickupDate)} och du får ett nytt mejl med spårningslänk så snart paketet är på väg.`
      : "Du får ett nytt mejl med spårningslänk så snart paketet är på väg.";
  const items = sheets.map((s) => {
    const size = `${cm(s.widthMm)} × ${cm(s.heightMm)} cm`;
    const qty = s.lineQuantity || 1;
    return s.kind === "cut"
      ? `${qty} st ${s.printType || "DTF Transfer"}, ${size}`
      : `${s.printType || "DTF Transfer"} gang sheet ${size}${qty > 1 ? `, ${qty} st` : ""}`;
  });

  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f3f1" style="background:#f4f3f1;">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td style="padding:0 8px 16px;font-family:${FONT};font-size:18px;font-weight:800;color:#111;">Transfer<span style="color:${RED};">craft</span></td></tr>
      <tr><td bgcolor="#ffffff" style="background:#fff;border-radius:14px;padding:32px;font-family:${FONT};color:#333;font-size:15px;line-height:1.6;">
        <div style="font-size:12px;font-weight:700;color:${RED};text-transform:uppercase;letter-spacing:.5px;">Order ${esc(order)}</div>
        <div style="padding-top:6px;font-size:22px;font-weight:700;color:#111;">Vi har börjat tillverka din order</div>
        <p style="margin:16px 0 0;">Hej${firstName ? ` ${esc(firstName)}` : ""}!</p>
        <p style="margin:8px 0 0;">Tack för din beställning. Din order har gått till produktion och vi trycker nu dina transfers. ${esc(when)}</p>
        <div style="margin-top:20px;background:#f4f3f1;border-radius:12px;padding:14px 18px;font-size:14px;color:#111;">
          ${items.map((i) => `<div style="padding:3px 0;">${esc(i)}</div>`).join("")}
        </div>
        <p style="margin:20px 0 0;font-size:14px;color:#666;">Frågor? Svara på det här mejlet eller skriv till info@transfercraft.com.</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;

  const text = [
    `Order ${order}: Vi har börjat tillverka din order`,
    "",
    `Hej${firstName ? ` ${firstName}` : ""}!`,
    `Tack för din beställning. Din order har gått till produktion och vi trycker nu dina transfers. ${when}`,
    "",
    ...items.map((i) => `- ${i}`),
    "",
    "Frågor? Svara på det här mejlet eller skriv till info@transfercraft.com.",
  ].join("\n");

  return { subject: `Din order ${order} är i produktion`, html, text };
}

async function sendProductionMail(sheets: Sheet[]): Promise<{ ok: boolean; error?: string }> {
  const first = sheets[0];
  const to = ((first.shippingAddress as Record<string, string | null> | null) || {}).email;
  if (!to) return { ok: false, error: "Sent to the print shop, but the order has no customer email for the production notice." };
  const mail = productionMail(sheets);
  try {
    await sendMail({
      to,
      from: process.env.CUSTOMER_MAIL_FROM || mailFrom(),
      replyTo: process.env.CUSTOMER_REPLY_TO || undefined,
      ...mail,
    });
  } catch (error) {
    return { ok: false, error: `Sent to the print shop, but the customer email failed: ${(error as Error).message}` };
  }
  await prisma.gangSheet.updateMany({
    where: { shopDomain: first.shopDomain, shopifyOrderId: first.shopifyOrderId },
    data: { productionMailSentAt: new Date() },
  });
  return { ok: true };
}

/** For previews: the two emails for an order, without sending anything. */
export async function previewMails(shopDomain: string, shopifyOrderId: string, message?: string) {
  const sheets = await loadOrder(shopDomain, shopifyOrderId);
  const files = jobFiles(sheets);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const input = { sheets, files, attachFiles: total > 0 && total <= MAX_ATTACH_BYTES, hasLabel: Boolean(sheets[0]?.shippingLabelKey), message };
  return { printShop: printShopHtml(input), printShopText: printShopText(input), customer: productionMail(sheets) };
}


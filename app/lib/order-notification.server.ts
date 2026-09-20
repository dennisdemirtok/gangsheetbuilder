/**
 * Order notification — sends email to printing supplier when order is placed.
 * Uses Shopify's built-in email or a custom SMTP setup.
 */

export interface OrderNotificationData {
  orderId: string;
  gangSheetId: string;
  shopDomain: string;
  customerEmail?: string;
  sheetSize: string;
  filmType: string;
  designCount: number;
  totalPrice: number;
  exportUrl?: string;
  previewUrl?: string;
}

/**
 * Send order notification email to the printing supplier.
 * Falls back to console.log if no email config is set.
 */
export async function sendOrderNotification(
  data: OrderNotificationData,
  supplierEmail?: string,
): Promise<void> {
  if (!supplierEmail) {
    console.log("[ORDER] No supplier email configured — skipping notification");
    console.log("[ORDER] Data:", JSON.stringify(data, null, 2));
    return;
  }

  const subject = `Ny beställning: Gang Sheet ${data.sheetSize} — ${data.filmType}`;
  const body = buildEmailBody(data);

  // Use fetch to send via a simple email API (SendGrid, Resend, etc.)
  const emailApiKey = process.env.EMAIL_API_KEY;
  const emailFrom = process.env.EMAIL_FROM || "orders@transfercraft.se";

  if (emailApiKey && process.env.EMAIL_SERVICE === "resend") {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${emailApiKey}`,
        },
        body: JSON.stringify({
          from: emailFrom,
          to: supplierEmail,
          subject,
          html: body,
        }),
      });
      console.log("[ORDER] Email sent to", supplierEmail);
    } catch (error) {
      console.error("[ORDER] Failed to send email:", error);
    }
  } else {
    // Log the notification for manual processing
    console.log("[ORDER] ========================================");
    console.log("[ORDER] NEW ORDER NOTIFICATION");
    console.log("[ORDER] To:", supplierEmail);
    console.log("[ORDER] Subject:", subject);
    console.log("[ORDER]", body.replace(/<[^>]+>/g, ""));
    console.log("[ORDER] ========================================");
  }
}

// Samma formspråk som butikens Shopify-notiser: Inter, röd #DC2F3C, mörk #111, varm grå #f4f3f1.
const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label: string, value: string): string {
  return `
            <tr>
              <td style="padding:10px 0;border-top:1px solid #ececec;font-family:${FONT};font-size:14px;color:#666666;">${label}</td>
              <td align="right" style="padding:10px 0;border-top:1px solid #ececec;font-family:${FONT};font-size:14px;font-weight:700;color:#111111;">${value}</td>
            </tr>`;
}

function buildEmailBody(data: OrderNotificationData): string {
  const fileBlock = data.exportUrl
    ? `
          <tr><td style="padding:28px 40px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td bgcolor="#DC2F3C" style="border-radius:14px;">
                <a href="${escapeHtml(data.exportUrl)}" style="display:inline-block;padding:15px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:14px;">Ladda ned tryckfil</a>
              </td>
            </tr></table>
            <div style="padding-top:8px;font-family:${FONT};font-size:12px;color:#8a8a8a;">300 DPI PNG</div>
          </td></tr>`
    : `
          <tr><td style="padding:28px 40px 0;">
            <div style="background:#f4f3f1;border-radius:14px;padding:16px 20px;font-family:${FONT};font-size:14px;line-height:1.6;color:#333333;">Tryckfilen exporteras — du får ett nytt mejl när den är klar.</div>
          </td></tr>`;

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f3f1" style="background:#f4f3f1;">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td style="padding:0 8px 20px;font-family:${FONT};font-size:26px;font-weight:800;letter-spacing:-0.5px;color:#111111;">Transfer<span style="color:#DC2F3C;">craft</span></td></tr>
      <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:40px 40px 0;">
            <span style="display:inline-block;background:#fdecee;color:#c5303c;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;padding:6px 12px;border-radius:100px;">Ny beställning</span>
          </td></tr>
          <tr><td style="padding:16px 40px 0;font-family:${FONT};font-size:30px;line-height:1.12;font-weight:700;letter-spacing:-0.8px;color:#000000;">Gang sheet ${escapeHtml(data.sheetSize)}</td></tr>
          <tr><td style="padding:12px 40px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#333333;">${escapeHtml(data.filmType)} · ${escapeHtml(data.designCount)} designs</td></tr>
          ${fileBlock}
          <tr><td style="padding:28px 40px 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${row("Order-ID", escapeHtml(data.orderId))}
              ${row("Arkstorlek", escapeHtml(data.sheetSize))}
              ${row("Filmtyp", escapeHtml(data.filmType))}
              ${row("Antal designs", escapeHtml(data.designCount))}
              ${row("Pris", `${escapeHtml(data.totalPrice)} kr`)}
              ${data.customerEmail ? row("Kund", `<a href="mailto:${escapeHtml(data.customerEmail)}" style="color:#DC2F3C;">${escapeHtml(data.customerEmail)}</a>`) : ""}
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;color:#8a8a8a;">Skickat från Transfercraft Gang Sheet Builder</td></tr>
    </table>
  </td></tr>
</table>`;
}

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

function buildEmailBody(data: OrderNotificationData): string {
  return `
    <div style="font-family: 'Plus Jakarta Sans', system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="background: linear-gradient(135deg, #bb0018, #e8002a); padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px; font-weight: 600;">Ny Gang Sheet Beställning</h1>
      </div>

      <div style="background: #fff; border: 1px solid #e6e8ea; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Order-ID:</td>
            <td style="padding: 8px 0; font-weight: 600;">${data.orderId}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Arkstorlek:</td>
            <td style="padding: 8px 0; font-weight: 600;">${data.sheetSize}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Filmtyp:</td>
            <td style="padding: 8px 0; font-weight: 600;">${data.filmType}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Antal designs:</td>
            <td style="padding: 8px 0; font-weight: 600;">${data.designCount}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Pris:</td>
            <td style="padding: 8px 0; font-weight: 600;">${data.totalPrice} kr</td>
          </tr>
          ${data.customerEmail ? `
          <tr>
            <td style="padding: 8px 0; color: #4f6071; font-weight: 500;">Kund:</td>
            <td style="padding: 8px 0;">${data.customerEmail}</td>
          </tr>
          ` : ""}
        </table>

        ${data.exportUrl ? `
        <div style="margin-top: 20px; padding: 16px; background: #f2f4f6; border-radius: 6px;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #4f6071;">Ladda ned tryckfil (300 DPI PNG):</p>
          <a href="${data.exportUrl}" style="color: #bb0018; font-weight: 600; font-size: 14px; text-decoration: none;">
            ↓ Ladda ned tryckfil
          </a>
        </div>
        ` : `
        <div style="margin-top: 20px; padding: 16px; background: #fff3cd; border-radius: 6px;">
          <p style="margin: 0; font-size: 13px; color: #856404;">Tryckfilen exporteras — du meddelas när den är klar.</p>
        </div>
        `}

        <p style="margin: 24px 0 0; font-size: 12px; color: #8a9199; text-align: center;">
          Skickat från TransferCraft Gang Sheet Builder
        </p>
      </div>
    </div>
  `;
}

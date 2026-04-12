import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createBwsShipment,
  estimateWeight,
  estimatePackageDimensions,
} from "../lib/bws-shipping.server";

/**
 * Create a shipment for a gang sheet order via BWS.
 * Called from the order detail page in admin.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const { id } = params;

    if (!id) return json({ error: "Missing order ID" }, { status: 400 });

    const body = await request.formData();

    const gangSheet = await prisma.gangSheet.findUnique({
      where: { id },
      include: { images: true },
    });

    if (!gangSheet || gangSheet.shopDomain !== session.shop) {
      return json({ error: "Order not found" }, { status: 404 });
    }

    const recipientName = String(body.get("recipientName") || "");
    const recipientAddress = String(body.get("recipientAddress") || "");
    const recipientCity = String(body.get("recipientCity") || "");
    const recipientZip = String(body.get("recipientZip") || "");
    const recipientCountry = String(body.get("recipientCountry") || "SE");
    const recipientPhone = String(body.get("recipientPhone") || "");
    const recipientEmail = String(body.get("recipientEmail") || "");

    const weightKg = estimateWeight(gangSheet.widthMm, gangSheet.heightMm);
    const dims = estimatePackageDimensions(gangSheet.widthMm);
    const sizeLabel = `${gangSheet.widthMm / 10}x${gangSheet.heightMm / 10}cm`;

    const result = await createBwsShipment({
      senderName: process.env.SENDER_NAME || "TransferCraft AB",
      senderAddress: process.env.SENDER_ADDRESS || "",
      senderCity: process.env.SENDER_CITY || "",
      senderZip: process.env.SENDER_ZIP || "",
      senderCountry: process.env.SENDER_COUNTRY || "SE",
      senderPhone: process.env.SENDER_PHONE || "",
      senderEmail: process.env.SENDER_EMAIL || "",
      recipientName,
      recipientAddress,
      recipientCity,
      recipientZip,
      recipientCountry,
      recipientPhone,
      recipientEmail,
      weightKg,
      lengthCm: dims.lengthCm,
      widthCm: dims.widthCm,
      heightCm: dims.heightCm,
      description: `DTF Gang Sheet ${sizeLabel} — ${gangSheet.filmType}`,
      orderReference: gangSheet.shopifyOrderId || gangSheet.id,
      totalValueSEK: gangSheet.priceSEK || 0,
    });

    if (result.success) {
      await prisma.gangSheet.update({
        where: { id },
        data: {
          canvasStateJson: {
            ...((gangSheet.canvasStateJson as any) || {}),
            tracking: {
              transactionId: result.transactionId,
              trackingNumber: result.trackingNumber,
              labelUrl: result.labelUrl,
              shippedAt: new Date().toISOString(),
            },
          },
        },
      });
    }

    return json(result);
  } catch (error) {
    console.error("Ship error:", error);
    return json(
      { error: `Shipment failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

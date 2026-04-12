import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import sharp from "sharp";
import { authenticate } from "../shopify.server";
import { downloadFile, uploadFile } from "../lib/r2.server";
import prisma from "../db.server";
import { pxToMm } from "../lib/constants";

/**
 * Crop (trim) whitespace/transparency around an image.
 * Returns the cropped image URL and new dimensions.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { imageId } = body;

    if (!imageId) {
      return json({ error: "Missing imageId" }, { status: 400 });
    }

    const image = await prisma.gangSheetImage.findUnique({
      where: { id: imageId },
    });

    if (!image) {
      return json({ error: "Image not found" }, { status: 404 });
    }

    // Download original
    const buffer = await downloadFile(image.originalUrl);

    // Trim whitespace/transparency
    const trimmed = await sharp(buffer)
      .trim({ threshold: 10 })
      .png()
      .toBuffer();

    const meta = await sharp(trimmed).metadata();
    const newWidth = meta.width || image.widthPx;
    const newHeight = meta.height || image.heightPx;

    // Upload cropped version
    const parts = image.originalUrl.split("/");
    const sessionPart = parts[1] || "unknown";
    const imagePart = parts[2] || imageId;
    const croppedKey = "uploads/" + sessionPart + "/" + imagePart + "/cropped.png";

    await uploadFile(croppedKey, trimmed, "image/png");

    // Update database
    await prisma.gangSheetImage.update({
      where: { id: imageId },
      data: {
        widthPx: newWidth,
        heightPx: newHeight,
      },
    });

    // Calculate display size in mm at original DPI
    const dpi = image.dpiX || 72;
    const displayWidthMm = pxToMm(newWidth, dpi);
    const displayHeightMm = pxToMm(newHeight, dpi);

    return json({
      croppedUrl: "/api/image/" + croppedKey,
      width: newWidth,
      height: newHeight,
      displayWidthMm,
      displayHeightMm,
    });
  } catch (error) {
    console.error("Crop error:", error);
    return json(
      { error: "Crop failed: " + (error as Error).message },
      { status: 500 },
    );
  }
};

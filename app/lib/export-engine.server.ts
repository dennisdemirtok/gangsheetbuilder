import prisma from "../db.server";
import { downloadFile, uploadFile, exportKey } from "./r2.server";
import {
  compositeGangSheet,
  generatePreview,
  type CompositeImage,
} from "./image-processing.server";
import { mmToPx, EXPORT_DPI } from "./constants";

/**
 * Generate the final 300 DPI export file for a gang sheet.
 * Called by the BullMQ worker after order payment.
 */
export async function exportGangSheet(gangSheetId: string): Promise<{
  pngUrl: string;
  pngKey: string;
}> {
  // Load gang sheet and images from database
  const gangSheet = await prisma.gangSheet.findUniqueOrThrow({
    where: { id: gangSheetId },
    include: { images: true },
  });

  // Calculate canvas dimensions in pixels at export DPI
  const canvasWidthPx = mmToPx(gangSheet.widthMm, EXPORT_DPI);
  const canvasHeightPx = mmToPx(gangSheet.heightMm, EXPORT_DPI);

  // Download all images and prepare for compositing
  const compositeImages: CompositeImage[] = [];

  for (const image of gangSheet.images) {
    if (
      image.positionX == null ||
      image.positionY == null ||
      image.displayWidth == null ||
      image.displayHeight == null
    ) {
      continue; // Skip images not placed on canvas
    }

    // Use bg-removed version if available, otherwise original
    const imageUrl = image.bgRemovedUrl || image.originalUrl;

    // Extract the R2 key from the URL
    const key = extractR2Key(imageUrl);
    const buffer = await downloadFile(key);

    // For each copy (quantity), the positions should already be in the canvas state
    // The canvas state stores individual placements including duplicates
    compositeImages.push({
      buffer,
      x: mmToPx(image.positionX, EXPORT_DPI),
      y: mmToPx(image.positionY, EXPORT_DPI),
      width: mmToPx(image.displayWidth, EXPORT_DPI),
      height: mmToPx(image.displayHeight, EXPORT_DPI),
      rotation: image.rotation,
      flipX: image.flipX,
      flipY: image.flipY,
    });
  }

  // Composite all images onto the canvas
  const pngBuffer = await compositeGangSheet(
    compositeImages,
    canvasWidthPx,
    canvasHeightPx,
  );

  // Upload PNG export
  const pngKey = exportKey(gangSheetId, "png");
  await uploadFile(pngKey, pngBuffer, "image/png");

  // Generate and upload preview
  const previewBuffer = await generatePreview(pngBuffer);
  const previewKey = exportKey(gangSheetId, "preview.webp");
  await uploadFile(previewKey, previewBuffer, "image/webp");

  // Update database
  await prisma.gangSheet.update({
    where: { id: gangSheetId },
    data: {
      status: "exported",
      exportUrl: pngKey,
      previewUrl: previewKey,
    },
  });

  // Create export record
  await prisma.gangSheetExport.create({
    data: {
      gangSheetId,
      format: "png",
      url: pngKey,
      fileSizeBytes: pngBuffer.length,
      dpi: EXPORT_DPI,
    },
  });

  return { pngUrl: pngKey, pngKey };
}

/**
 * Extract R2 storage key from a URL or key string.
 */
function extractR2Key(urlOrKey: string): string {
  // If it's already a key (no protocol), return as-is
  if (!urlOrKey.startsWith("http")) return urlOrKey;

  try {
    const url = new URL(urlOrKey);
    // Remove leading slash
    return url.pathname.slice(1);
  } catch {
    return urlOrKey;
  }
}

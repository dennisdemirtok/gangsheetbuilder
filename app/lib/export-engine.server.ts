import prisma from "../db.server";
import { downloadFile, uploadFile, exportKey } from "./r2.server";
import {
  compositeGangSheet,
  generatePreview,
  type CompositeImage,
} from "./image-processing.server";
import { mmToPx, EXPORT_DPI } from "./constants";
import { computeCopyPlacements, resolveRasterKey } from "./placement";

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

    // Use bg-removed version if available, otherwise original.
    // Vector originals (EPS/AI/PS) are resolved to their rasterized PNG.
    const imageUrl = image.bgRemovedUrl || image.originalUrl;

    // Extract the R2 key from the URL
    const key = resolveRasterKey(extractR2Key(imageUrl));
    const buffer = await downloadFile(key);

    // Compute one placement per copy using the shared quantity grid
    const { placements, skipped } = computeCopyPlacements(
      {
        positionX: image.positionX,
        positionY: image.positionY,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
        rotation: image.rotation,
        quantity: image.quantity,
      },
      gangSheet.widthMm,
      gangSheet.heightMm,
    );

    if (skipped > 0) {
      console.warn(
        `[export] Gang sheet ${gangSheetId}: skipped ${skipped} copies of "${image.originalFilename}" that exceed the sheet bottom`,
      );
    }

    for (const placement of placements) {
      compositeImages.push({
        buffer,
        x: mmToPx(placement.xMm, EXPORT_DPI),
        y: mmToPx(placement.yMm, EXPORT_DPI),
        width: mmToPx(image.displayWidth, EXPORT_DPI),
        height: mmToPx(image.displayHeight, EXPORT_DPI),
        rotation: image.rotation,
        flipX: image.flipX,
        flipY: image.flipY,
      });
    }
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

  // Upsert export record (idempotent across webhook redeliveries)
  const existingExport = await prisma.gangSheetExport.findFirst({
    where: { gangSheetId, format: "png" },
  });
  if (existingExport) {
    await prisma.gangSheetExport.update({
      where: { id: existingExport.id },
      data: {
        url: pngKey,
        fileSizeBytes: pngBuffer.length,
        dpi: EXPORT_DPI,
      },
    });
  } else {
    await prisma.gangSheetExport.create({
      data: {
        gangSheetId,
        format: "png",
        url: pngKey,
        fileSizeBytes: pngBuffer.length,
        dpi: EXPORT_DPI,
      },
    });
  }

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

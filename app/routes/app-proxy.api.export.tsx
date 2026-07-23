import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile } from "../lib/r2.server";
import {
  compositeGangSheet,
  type CompositeImage,
} from "../lib/image-processing.server";
import { mmToPx, EXPORT_DPI } from "../lib/constants";
import { computeCopyPlacements, resolveRasterKey } from "../lib/placement";

/**
 * Export a gang sheet as 300 DPI PNG.
 * Called by the editor's download button.
 * Returns the PNG binary data directly.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { images, sheetWidthMm, sheetHeightMm } = body;

    if (!images || !sheetWidthMm || !sheetHeightMm) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    // Same dimension bounds as app-proxy.api.gang-sheet.tsx
    if (
      typeof sheetWidthMm !== "number" ||
      typeof sheetHeightMm !== "number" ||
      sheetWidthMm <= 0 ||
      sheetHeightMm <= 0 ||
      sheetWidthMm > 10000 ||
      sheetHeightMm > 100000
    ) {
      return json({ error: "Invalid dimensions" }, { status: 400 });
    }

    const canvasWidthPx = mmToPx(sheetWidthMm, EXPORT_DPI);
    const canvasHeightPx = mmToPx(sheetHeightMm, EXPORT_DPI);

    const compositeImages: CompositeImage[] = [];

    for (const img of images) {
      const imageKey = img.bgRemovedUrl || img.originalUrl;
      const r2Key = resolveRasterKey(
        imageKey
          .replace(/^\/api\/image\//, "")
          .replace(/^\/apps\/gangsheet\/api\/image\//, ""),
      );

      // Only allow reads from the uploads/ prefix — no arbitrary R2 keys.
      if (!r2Key.startsWith("uploads/") || r2Key.includes("..")) {
        console.warn("Rejected image key outside uploads/: " + r2Key);
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await downloadFile(r2Key);
      } catch (err) {
        console.error("Failed to download image " + r2Key + ":", err);
        continue;
      }

      const { placements, skipped } = computeCopyPlacements(
        {
          positionX: img.positionX,
          positionY: img.positionY,
          displayWidth: img.displayWidth,
          displayHeight: img.displayHeight,
          rotation: img.rotation || 0,
          quantity: img.quantity || 1,
          marginMm: img.marginMm,
        },
        sheetWidthMm,
        sheetHeightMm,
      );

      if (skipped > 0) {
        console.warn(
          `[export] Skipped ${skipped} copies of "${r2Key}" that exceed the sheet bottom`,
        );
      }

      for (const placement of placements) {
        compositeImages.push({
          buffer,
          x: mmToPx(placement.xMm, EXPORT_DPI),
          y: mmToPx(placement.yMm, EXPORT_DPI),
          width: mmToPx(img.displayWidth, EXPORT_DPI),
          height: mmToPx(img.displayHeight, EXPORT_DPI),
          rotation: img.rotation || 0,
          flipX: img.flipX || false,
          flipY: img.flipY || false,
        });
      }
    }

    if (compositeImages.length === 0) {
      return json({ error: "Inga bilder att exportera" }, { status: 400 });
    }

    const pngBuffer = await compositeGangSheet(
      compositeImages,
      canvasWidthPx,
      canvasHeightPx,
    );

    return new Response(pngBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(pngBuffer.length),
        "Content-Disposition": "attachment; filename=\"gangsheet-300dpi.png\"",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Export error:", error);
    return json(
      { error: "Export failed: " + (error as Error).message },
      { status: 500 },
    );
  }
};

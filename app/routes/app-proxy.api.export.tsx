import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile } from "../lib/r2.server";
import {
  compositeGangSheet,
  type CompositeImage,
} from "../lib/image-processing.server";
import { mmToPx, EXPORT_DPI } from "../lib/constants";

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

    const canvasWidthPx = mmToPx(sheetWidthMm, EXPORT_DPI);
    const canvasHeightPx = mmToPx(sheetHeightMm, EXPORT_DPI);

    const compositeImages: CompositeImage[] = [];

    for (const img of images) {
      const imageKey = img.bgRemovedUrl || img.originalUrl;
      const r2Key = imageKey
        .replace(/^\/api\/image\//, "")
        .replace(/^\/apps\/gangsheet\/api\/image\//, "");

      let buffer: Buffer;
      try {
        buffer = await downloadFile(r2Key);
      } catch (err) {
        console.error("Failed to download image " + r2Key + ":", err);
        continue;
      }

      const qty = img.quantity || 1;
      const gap = 5;
      const cellW = img.displayWidth + gap;
      const cellH = img.displayHeight + gap;
      const cols = Math.floor((sheetWidthMm - gap) / cellW) || 1;

      for (let q = 0; q < qty; q++) {
        let posX: number;
        let posY: number;

        if (qty === 1) {
          posX = img.positionX;
          posY = img.positionY;
        } else {
          const col = q % cols;
          const row = Math.floor(q / cols);
          posX = gap + col * cellW;
          posY = gap + row * cellH;
        }

        compositeImages.push({
          buffer,
          x: mmToPx(posX, EXPORT_DPI),
          y: mmToPx(posY, EXPORT_DPI),
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

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { packImages, suggestLargerSheet } from "../lib/bin-packing.server";
import prisma from "../db.server";
import { pxToMm } from "../lib/constants";

/** Upper bound on how many motifs one request may nest. */
const MAX_ITEMS = 2000;

/**
 * Run the MAXRECTS auto-build nesting algorithm.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { gangSheetId, sheetWidthMm, sheetHeightMm, gapMm = 5, items } = body;

    if (!sheetWidthMm || !sheetHeightMm) {
      return json({ error: "Missing sheet dimensions" }, { status: 400 });
    }

    if (sheetWidthMm <= 0 || sheetHeightMm <= 0 || sheetWidthMm > 10000 || sheetHeightMm > 100000) {
      return json({ error: "Invalid sheet dimensions" }, { status: 400 });
    }

    /*
     * Preferred path: the editor sends one item per copy, keyed by its own
     * image id. Packing the database rows instead can't work once a design
     * has copies — they share one row, so every copy would come back with
     * the same position.
     */
    let packingInputs: { id: string; width: number; height: number; quantity: number }[];

    if (Array.isArray(items) && items.length > 0) {
      packingInputs = [];
      for (const item of items.slice(0, MAX_ITEMS)) {
        const width = Number(item?.width);
        const height = Number(item?.height);
        if (
          typeof item?.id !== "string" ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0
        ) {
          continue;
        }
        packingInputs.push({ id: item.id, width, height, quantity: 1 });
      }
      if (packingInputs.length === 0) {
        return json({ error: "Inga giltiga motiv att arrangera" }, { status: 400 });
      }
    } else {
      // Legacy path — pack whatever is linked to the gang sheet.
      if (!gangSheetId) {
        return json({ error: "Missing gangSheetId" }, { status: 400 });
      }
      const images = await prisma.gangSheetImage.findMany({
        where: { gangSheetId },
      });

      if (images.length === 0) {
        return json({ error: "Inga bilder att arrangera" }, { status: 400 });
      }

      packingInputs = images.map((img) => {
        const dpi = img.dpiX || 72;
        const widthMm = img.displayWidth || pxToMm(img.widthPx, dpi);
        const heightMm = img.displayHeight || pxToMm(img.heightPx, dpi);

        return {
          id: img.id,
          width: widthMm,
          height: heightMm,
          quantity: img.quantity,
        };
      });
    }

    const result = packImages(
      packingInputs,
      sheetWidthMm,
      sheetHeightMm,
      Math.max(0, Math.min(50, gapMm)),
    );

    const sizeKey = `${Math.round(sheetWidthMm / 10)}x${Math.round(sheetHeightMm / 10)}`;
    const suggestion = result.overflow.length > 0
      ? suggestLargerSheet(sizeKey)
      : null;

    return json({
      placements: result.placements,
      usedHeight: result.usedHeight,
      utilization: Math.round(result.utilization * 100),
      overflow: result.overflow,
      suggestedSize: suggestion,
    });
  } catch (error) {
    console.error("Auto-build error:", error);
    return json(
      { error: `Auto-build failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile, uploadFile } from "../lib/r2.server";
import { extractMetadata, generateThumbnail } from "../lib/image-processing.server";
import { SHEET_WIDTH_MM } from "../lib/constants";
import prisma from "../db.server";

/** Resolution a ready sheet must reach across the 58 cm film width. */
const REQUIRED_DPI = 300;

/**
 * Analyze a pre-uploaded sheet file in R2.
 * Called after direct browser→R2 upload via presigned URL.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { r2Key, sheetId, filename, fileSize } = body;

    if (!r2Key || !sheetId) {
      return json({ error: "Missing r2Key or sheetId" }, { status: 400 });
    }

    // Download from R2 for analysis
    let buffer: Buffer;
    try {
      buffer = await downloadFile(r2Key);
    } catch (dlError) {
      console.error("Failed to download from R2:", dlError);
      return json({ error: "Kunde inte hämta filen från lagring. Försök igen." }, { status: 500 });
    }

    console.log("Analyze-sheet: downloaded", buffer.length, "bytes from R2 key:", r2Key);

    // Extract metadata — use Sharp with pipeline to handle large files
    let metadata;
    try {
      const sharp = (await import("sharp")).default;
      const sharpMeta = await sharp(buffer, { limitInputPixels: false }).metadata();
      const dpi = sharpMeta.density || 300;
      metadata = {
        width: sharpMeta.width || 0,
        height: sharpMeta.height || 0,
        dpiX: dpi,
        dpiY: dpi,
        format: sharpMeta.format || "unknown",
        hasAlpha: sharpMeta.hasAlpha || false,
        hasWhiteBackground: false,
        colorSpace: sharpMeta.space || "srgb",
        channels: sharpMeta.channels || 3,
        fileSize: fileSize || buffer.length,
      };
      console.log("Analyze-sheet: metadata", metadata.width, "x", metadata.height, "dpi:", metadata.dpiX);
    } catch (metaError) {
      console.error("Sharp metadata error:", metaError);
      metadata = {
        width: 0, height: 0, dpiX: 300, dpiY: 300,
        format: "unknown", hasAlpha: false, hasWhiteBackground: false,
        colorSpace: "srgb", channels: 3, fileSize: fileSize || 0,
      };
    }

    /*
     * Judge the file by its pixels, not by its DPI tag.
     *
     * A ready sheet is printed at the full 58 cm film width, so the width is
     * a given and the resolution follows from the pixel count. The DPI tag
     * says nothing about quality: a 6850 px file IS 300 DPI at 58 cm whether
     * or not it carries a pHYs chunk, and most export pipelines omit one —
     * sharp then reports 72 and a perfectly good sheet was rejected as
     * "241.7 cm wide". Requiring the pixels instead enforces the real
     * quality bar and stops punishing files for missing metadata.
     */
    const inchesWide = SHEET_WIDTH_MM / 25.4;
    const effectiveDpi = Math.round(metadata.width / inchesWide);
    const requiredWidthPx = Math.round(REQUIRED_DPI * inchesWide);

    // Printed size follows from the resolution we just derived.
    const widthMm = SHEET_WIDTH_MM;
    const heightMm =
      effectiveDpi > 0 ? (metadata.height / effectiveDpi) * 25.4 : 0;

    const warnings: string[] = [];
    let approved = true;

    if (!metadata.width || !metadata.height) {
      warnings.push("Kunde inte läsa bildens mått. Spara om filen som PNG och försök igen.");
      approved = false;
    } else if (effectiveDpi < REQUIRED_DPI) {
      warnings.push(
        `Filen är ${metadata.width} px bred, vilket ger ${effectiveDpi} DPI utskriven i 58 cm bredd. ` +
          `Det blir pixligt. Spara om arket minst ${requiredWidthPx} px brett (58 cm i ${REQUIRED_DPI} DPI).`,
      );
      approved = false;
    }

    // A declared DPI that disagrees is worth saying out loud — it usually
    // means the file was set up for a different width than 58 cm.
    const declaredDpi = metadata.dpiX || 0;
    if (
      approved &&
      declaredDpi > 0 &&
      Math.abs(declaredDpi - effectiveDpi) / effectiveDpi > 0.1
    ) {
      const declaredWidthCm = (metadata.width / declaredDpi) * 2.54;
      warnings.push(
        `Filen är märkt ${declaredDpi} DPI, vilket motsvarar ${declaredWidthCm.toFixed(1)} cm bredd. ` +
          `Vi skriver ut den i 58 cm, alltså ${effectiveDpi} DPI. Stämmer det?`,
      );
    }

    if (metadata.hasWhiteBackground) {
      warnings.push("Bilden verkar ha en vit bakgrund. DTF-tryck kräver transparent bakgrund.");
    }
    if (!metadata.hasAlpha) {
      warnings.push("Bilden saknar transparent bakgrund (alpha-kanal).");
    }

    const fileDpi = effectiveDpi;

    const heightCm = Math.ceil(heightMm / 10);
    const heightMeters = Math.ceil(heightMm / 1000);
    const sizeKey = `58x${heightMeters * 100}`;

    /*
     * Record an approved sheet as a normal gang sheet holding one
     * full-bleed image.
     *
     * This flow used to write nothing to the database, and orders/paid only
     * recognises `_gang_sheet_id`, so a ready-sheet order never reached the
     * app's admin and queued no export — the artwork was only findable by
     * digging the R2 key out of the Shopify line item. Reusing the existing
     * shape means orders, the designs list and the export pipeline all work
     * unchanged rather than needing a parallel path.
     */
    let gangSheetId: string | null = null;
    if (approved) {
      /*
       * A ready sheet had no thumbnail, so the admin Designs grid showed
       * "Ingen bild" for exactly the files the print shop needs to look at.
       * Generated here from the buffer we already downloaded.
       */
      let thumbnailKey: string | null = null;
      try {
        const thumb = await generateThumbnail(buffer);
        const key = r2Key.replace(/\/original\.[^.]+$/, "/thumbnail.webp");
        await uploadFile(key, thumb, "image/webp");
        thumbnailKey = key;
      } catch (thumbError) {
        // A missing thumbnail costs a preview, not the order.
        console.error("Could not build ready-sheet thumbnail:", thumbError);
        thumbnailKey = null;
      }

      try {
        const created = await prisma.gangSheet.create({
          data: {
            sessionId: sheetId,
            shopDomain: session.shop,
            widthMm: Math.round(widthMm),
            heightMm: Math.round(heightMm),
            filmType: "standard",
            status: "draft",
            imagesCount: 1,
            images: {
              create: {
                originalUrl: r2Key,
                thumbnailUrl: thumbnailKey,
                originalFilename: filename || "fardigt-ark.png",
                mimeType: `image/${metadata.format || "png"}`,
                fileSizeBytes: Math.round(fileSize || buffer.length),
                widthPx: metadata.width,
                heightPx: metadata.height,
                dpiX: effectiveDpi,
                dpiY: effectiveDpi,
                // Fills the sheet exactly — it is already laid out.
                positionX: 0,
                positionY: 0,
                displayWidth: Math.round(widthMm),
                displayHeight: Math.round(heightMm),
                rotation: 0,
                quantity: 1,
              },
            },
          },
        });
        gangSheetId = created.id;
      } catch (dbError) {
        // A missing record costs admin visibility, not the customer's order.
        console.error("Could not record ready sheet:", dbError);
      }
    }

    return json({
      sheetId,
      gangSheetId,
      r2Key,
      filename: filename || "unknown",
      widthPx: metadata.width,
      heightPx: metadata.height,
      widthMm: Math.round(widthMm),
      heightMm: Math.round(heightMm),
      widthCm: Math.round(widthMm / 10),
      heightCm,
      dpi: fileDpi,
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
      fileSizeBytes: fileSize || buffer.length,
      sizeKey,
      warnings,
      approved,
    });
  } catch (error) {
    console.error("Analyze sheet error:", error);
    return json(
      { error: `Analys misslyckades: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

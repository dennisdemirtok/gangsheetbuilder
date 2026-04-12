import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile } from "../lib/r2.server";
import { extractMetadata } from "../lib/image-processing.server";
import { SHEET_WIDTH_MM } from "../lib/constants";

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

    const fileDpi = metadata.dpiX || 72;
    const widthMm = (metadata.width / fileDpi) * 25.4;
    const heightMm = (metadata.height / fileDpi) * 25.4;

    const warnings: string[] = [];
    let approved = true;

    // Width check — must be ~58cm
    const expectedWidthMm = SHEET_WIDTH_MM;
    const widthDiff = Math.abs(widthMm - expectedWidthMm) / expectedWidthMm;
    if (widthDiff > 0.05) {
      warnings.push(
        `Arkets bredd är ${(widthMm / 10).toFixed(1)} cm men måste vara ${expectedWidthMm / 10} cm. ` +
        `Bildens bredd: ${metadata.width}px vid ${fileDpi} DPI = ${(widthMm / 10).toFixed(1)} cm.`
      );
      approved = false;
    }

    if (fileDpi < 300) {
      warnings.push(`Upplösningen är ${fileDpi} DPI. Rekommenderat: 300 DPI.`);
    }
    if (fileDpi < 150) {
      warnings.push(`Upplösningen ${fileDpi} DPI är för låg. Minst 150 DPI krävs.`);
      approved = false;
    }
    if (metadata.hasWhiteBackground) {
      warnings.push("Bilden verkar ha en vit bakgrund. DTF-tryck kräver transparent bakgrund.");
    }
    if (!metadata.hasAlpha) {
      warnings.push("Bilden saknar transparent bakgrund (alpha-kanal).");
    }

    const heightCm = Math.ceil(heightMm / 10);
    const heightMeters = Math.ceil(heightMm / 1000);
    const sizeKey = `58x${heightMeters * 100}`;

    return json({
      sheetId,
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

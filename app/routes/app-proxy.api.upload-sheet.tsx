import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { uploadFile, storageKey } from "../lib/r2.server";
import { extractMetadata } from "../lib/image-processing.server";
import { validateFile } from "../lib/file-validation.server";
import prisma from "../db.server";
import { v4 as uuidv4 } from "uuid";
import { SHEET_WIDTH_MM, EXPORT_DPI } from "../lib/constants";

/**
 * Upload a pre-built (ready-made) gang sheet.
 * Validates that:
 * - Width matches 58cm (580mm) at the file's DPI
 * - File is a valid image format
 * Returns warnings if DPI < 300
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!fileEntry || !(fileEntry instanceof File)) {
      return json({ error: "Ingen fil bifogad" }, { status: 400 });
    }

    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filename = fileEntry.name || "unknown";

    // Validate file format
    const validation = await validateFile(buffer, filename);
    if (!validation.valid) {
      return json({ error: validation.error }, { status: 400 });
    }

    // Extract metadata
    const metadata = await extractMetadata(buffer);

    // Calculate physical dimensions at file's DPI
    const fileDpi = metadata.dpiX || 72;
    const widthMm = (metadata.width / fileDpi) * 25.4;
    const heightMm = (metadata.height / fileDpi) * 25.4;

    // Warnings
    const warnings: string[] = [];
    let approved = true;

    // Check width — must be ~58cm (allow 5% tolerance)
    const expectedWidthMm = SHEET_WIDTH_MM; // 580mm
    const tolerance = 0.05;
    const widthDiff = Math.abs(widthMm - expectedWidthMm) / expectedWidthMm;

    if (widthDiff > tolerance) {
      warnings.push(
        `Arkets bredd är ${(widthMm / 10).toFixed(1)} cm men måste vara ${expectedWidthMm / 10} cm. ` +
        `Bildens bredd: ${metadata.width}px vid ${fileDpi} DPI = ${(widthMm / 10).toFixed(1)} cm.`
      );
      approved = false;
    }

    // Check DPI
    if (fileDpi < 300) {
      warnings.push(
        `Upplösningen är ${fileDpi} DPI. Rekommenderat: 300 DPI för bästa utskriftskvalitet.`
      );
    }

    if (fileDpi < 150) {
      warnings.push(
        `Upplösningen ${fileDpi} DPI är för låg för utskrift. Minst 150 DPI krävs.`
      );
      approved = false;
    }

    // Check if background looks wrong
    if (metadata.hasWhiteBackground) {
      warnings.push(
        "Bilden verkar ha en vit bakgrund. DTF-tryck kräver transparent bakgrund (PNG med alpha-kanal)."
      );
    }

    if (!metadata.hasAlpha) {
      warnings.push(
        "Bilden saknar transparent bakgrund (alpha-kanal). Kontrollera att bakgrunden är korrekt."
      );
    }

    // Calculate height in meters (rounded up)
    const heightCm = Math.ceil(heightMm / 10);
    const heightMeters = Math.ceil(heightMm / 1000);

    // Upload to R2
    const sheetId = uuidv4();
    const ext = validation.extension || "png";
    const r2Key = `ready-sheets/${session.shop}/${sheetId}/original.${ext}`;
    await uploadFile(r2Key, buffer, validation.mimeType!);

    // Determine size key and price
    const sizeKey = `58x${heightMeters * 100}`;

    return json({
      sheetId,
      r2Key,
      filename,
      widthPx: metadata.width,
      heightPx: metadata.height,
      widthMm: Math.round(widthMm),
      heightMm: Math.round(heightMm),
      widthCm: Math.round(widthMm / 10),
      heightCm,
      dpi: fileDpi,
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
      fileSizeBytes: buffer.length,
      sizeKey,
      warnings,
      approved,
    });
  } catch (error) {
    console.error("Upload sheet error:", error);
    return json(
      { error: `Upload misslyckades: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { uploadFile, storageKey } from "../lib/r2.server";
import { validateFile } from "../lib/file-validation.server";
import {
  extractMetadata,
  generateThumbnail,
  convertToRaster,
  needsGhostscript,
} from "../lib/image-processing.server";
import prisma from "../db.server";
import { v4 as uuidv4 } from "uuid";

/**
 * Handle image upload via multipart/form-data.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);

    if (!session) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");
    const sessionId = formData.get("sessionId") as string;
    const gangSheetId = formData.get("gangSheetId") as string;

    if (!fileEntry || !(fileEntry instanceof File)) {
      return json({ error: "Missing file" }, { status: 400 });
    }

    if (!sessionId) {
      return json({ error: "Missing sessionId" }, { status: 400 });
    }

    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filename = fileEntry.name || "unknown";

    // Validate file
    const validation = await validateFile(buffer, filename);
    if (!validation.valid) {
      return json({ error: validation.error }, { status: 400 });
    }

    // Convert EPS/AI to PNG via Ghostscript if needed
    let processBuffer = buffer;
    let convertedFromVector = false;
    if (needsGhostscript(filename)) {
      try {
        console.log("Converting EPS/AI to PNG via Ghostscript:", filename);
        processBuffer = await convertToRaster(buffer, filename, 300);
        convertedFromVector = true;
        console.log("Conversion successful:", processBuffer.length, "bytes");
      } catch (convErr) {
        console.error("Ghostscript conversion failed:", convErr);
        // Continue with original buffer — metadata will be limited
      }
    }

    // Extract metadata from the (possibly converted) buffer
    let metadata;
    try {
      metadata = await extractMetadata(processBuffer);
    } catch {
      metadata = {
        width: 1000, height: 1000, dpiX: 300, dpiY: 300,
        format: validation.extension || "unknown",
        hasAlpha: false, hasWhiteBackground: false,
        colorSpace: "srgb", channels: 3, fileSize: buffer.length,
      };
    }

    // Generate IDs and keys
    const imageId = uuidv4();
    const ext = validation.extension || "png";
    const originalKey = storageKey(sessionId, imageId, "original", ext);
    const thumbnailKey = storageKey(sessionId, imageId, "thumbnail", "webp");
    // Also store the converted PNG if it was vector
    const convertedKey = convertedFromVector
      ? storageKey(sessionId, imageId, "converted", "png")
      : null;

    // Generate thumbnail from the processable buffer
    let thumbnail: Buffer;
    try {
      thumbnail = await generateThumbnail(processBuffer);
    } catch {
      const sharpMod = (await import("sharp")).default;
      thumbnail = await sharpMod({ create: { width: 200, height: 200, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } } }).webp().toBuffer();
    }
    const uploads = [
      uploadFile(originalKey, buffer, validation.mimeType!),
      uploadFile(thumbnailKey, thumbnail, "image/webp"),
    ];
    if (convertedKey && convertedFromVector) {
      uploads.push(uploadFile(convertedKey, processBuffer, "image/png"));
    }
    await Promise.all(uploads);

    // Return thumbnail as base64 data URL — guaranteed to work, no CORS issues
    const thumbnailBase64 = `data:image/webp;base64,${thumbnail.toString("base64")}`;
    const originalUrlFull = `/api/image/${originalKey}`;

    // Save to database
    const image = await prisma.gangSheetImage.create({
      data: {
        gangSheetId:
          gangSheetId && gangSheetId.length > 0 ? gangSheetId : null,
        originalUrl: originalKey,
        thumbnailUrl: thumbnailKey,
        originalFilename: filename,
        mimeType: validation.mimeType!,
        fileSizeBytes: buffer.length,
        widthPx: metadata.width,
        heightPx: metadata.height,
        dpiX: metadata.dpiX,
        dpiY: metadata.dpiY,
      },
    });

    // Build warnings array
    const warnings: string[] = [];

    if (metadata.hasWhiteBackground) {
      warnings.push(
        "Bilden verkar ha en vit bakgrund. Använd 'Ta bort BG' för bästa resultat.",
      );
    }

    if (metadata.dpiX < 150) {
      warnings.push(
        `Låg upplösning (${metadata.dpiX} DPI). Bilden kan bli pixlig vid utskrift. Rekommenderat: minst 200 DPI.`,
      );
    }

    return json({
      id: image.id,
      imageId,
      originalUrl: originalUrlFull,
      thumbnailUrl: thumbnailBase64,
      width: metadata.width,
      height: metadata.height,
      dpiX: metadata.dpiX,
      dpiY: metadata.dpiY,
      filename,
      hasAlpha: metadata.hasAlpha,
      hasWhiteBackground: metadata.hasWhiteBackground,
      format: metadata.format,
      warnings,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return json(
      { error: `Upload failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

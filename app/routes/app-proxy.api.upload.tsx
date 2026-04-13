import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { uploadFile, storageKey, getPresignedDownloadUrl } from "../lib/r2.server";
import { validateFile } from "../lib/file-validation.server";
import {
  extractMetadata,
  generateThumbnail,
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

    // Extract metadata — EPS/AI files can't be read by Sharp, use fallback
    let metadata;
    try {
      metadata = await extractMetadata(buffer);
    } catch {
      // Fallback for formats Sharp can't read (EPS, AI, etc)
      metadata = {
        width: 1000,
        height: 1000,
        dpiX: 300,
        dpiY: 300,
        format: validation.extension || "unknown",
        hasAlpha: false,
        hasWhiteBackground: false,
        colorSpace: "srgb",
        channels: 3,
        fileSize: buffer.length,
      };
    }

    // Generate IDs and keys
    const imageId = uuidv4();
    const ext = validation.extension || "png";
    const originalKey = storageKey(sessionId, imageId, "original", ext);
    const thumbnailKey = storageKey(sessionId, imageId, "thumbnail", "webp");

    // Upload original and thumbnail to R2 — thumbnail may fail for unsupported formats
    let thumbnail: Buffer;
    try {
      thumbnail = await generateThumbnail(buffer);
    } catch {
      // Create a simple 1px placeholder for formats Sharp can't process
      const sharp = (await import("sharp")).default;
      thumbnail = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } } }).webp().toBuffer();
    }
    await Promise.all([
      uploadFile(originalKey, buffer, validation.mimeType!),
      uploadFile(thumbnailKey, thumbnail, "image/webp"),
    ]);

    // Return presigned R2 URLs (1 hour) — avoids app proxy for images
    let thumbnailUrlFull: string;
    let originalUrlFull: string;
    try {
      thumbnailUrlFull = await getPresignedDownloadUrl(thumbnailKey, 3600);
      originalUrlFull = await getPresignedDownloadUrl(originalKey, 3600);
    } catch {
      // Fallback to app proxy paths
      thumbnailUrlFull = `/api/image/${thumbnailKey}`;
      originalUrlFull = `/api/image/${originalKey}`;
    }

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
      thumbnailUrl: thumbnailUrlFull,
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

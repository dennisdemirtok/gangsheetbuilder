import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { uploadFile, storageKey } from "../lib/r2.server";
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

    // Extract metadata (includes white background detection)
    const metadata = await extractMetadata(buffer);

    // Generate IDs and keys
    const imageId = uuidv4();
    const ext = validation.extension || "png";
    const originalKey = storageKey(sessionId, imageId, "original", ext);
    const thumbnailKey = storageKey(sessionId, imageId, "thumbnail", "webp");

    // Upload original and thumbnail to R2
    const thumbnail = await generateThumbnail(buffer);
    await Promise.all([
      uploadFile(originalKey, buffer, validation.mimeType!),
      uploadFile(thumbnailKey, thumbnail, "image/webp"),
    ]);

    // Return relative paths — the editor prepends appProxyUrl
    const originalUrlFull = `/api/image/${originalKey}`;
    const thumbnailUrlFull = `/api/image/${thumbnailKey}`;

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

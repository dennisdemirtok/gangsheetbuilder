import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile, uploadFile, storageKey } from "../lib/r2.server";
import { removeWhiteBackground } from "../lib/image-processing.server";
import prisma from "../db.server";

/**
 * Remove background from an image.
 * Uses local Sharp processing for white backgrounds.
 * Falls back to remove.bg API if configured.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { imageId } = body;

    if (!imageId) {
      return json({ error: "Missing imageId" }, { status: 400 });
    }

    const image = await prisma.gangSheetImage.findUnique({
      where: { id: imageId },
    });

    if (!image) {
      return json({ error: "Image not found" }, { status: 404 });
    }

    if (image.bgRemoved && image.bgRemovedUrl) {
      return json({
        status: "already_done",
        bgRemovedUrl: image.bgRemovedUrl,
      });
    }

    // Download original image from R2
    const originalBuffer = await downloadFile(image.originalUrl);

    let resultBuffer: Buffer;

    // Try remove.bg API first if configured
    const removeBgApiKey = process.env.REMOVEBG_API_KEY;
    if (removeBgApiKey) {
      try {
        resultBuffer = await removeWithApi(originalBuffer, removeBgApiKey);
      } catch (apiError) {
        console.warn("remove.bg API failed, falling back to local:", apiError);
        resultBuffer = await removeWhiteBackground(originalBuffer);
      }
    } else {
      // Use local Sharp-based white background removal
      resultBuffer = await removeWhiteBackground(originalBuffer);
    }

    // Upload result to R2
    // Extract session and image parts from original URL
    const parts = image.originalUrl.split("/");
    const sessionPart = parts[1] || "unknown";
    const imagePart = parts[2] || imageId;
    const bgRemovedKey = `uploads/${sessionPart}/${imagePart}/bg-removed.png`;

    await uploadFile(bgRemovedKey, resultBuffer, "image/png");

    // Return relative path — the editor prepends appProxyUrl
    const bgRemovedUrlFull = `/api/image/${bgRemovedKey}`;

    // Update database
    await prisma.gangSheetImage.update({
      where: { id: imageId },
      data: {
        bgRemoved: true,
        bgRemovedUrl: bgRemovedKey,
      },
    });

    return json({
      status: "done",
      bgRemovedUrl: bgRemovedUrlFull,
    });
  } catch (error) {
    console.error("Remove BG error:", error);
    return json(
      { error: `Background removal failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

/**
 * Call remove.bg API for high-quality background removal.
 */
async function removeWithApi(
  buffer: Buffer,
  apiKey: string,
): Promise<Buffer> {
  const formData = new FormData();
  formData.append(
    "image_file",
    new Blob([buffer], { type: "image/png" }),
    "image.png",
  );
  formData.append("size", "auto");
  formData.append("format", "png");

  const response = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`remove.bg API error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

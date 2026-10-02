import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile, uploadFile, storageKey } from "../lib/r2.server";
import { removeAllWhite, removeWhiteBackground } from "../lib/image-processing.server";
import { resolveRasterKey } from "../lib/placement";
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
    // "background" (default): white around the design. "all": every white
    // pixel, also inside it — chosen by the customer after seeing the first.
    const mode: "background" | "all" = body.mode === "all" ? "all" : "background";

    if (!imageId) {
      return json({ error: "Missing imageId" }, { status: 400 });
    }

    const image = await prisma.gangSheetImage.findUnique({
      where: { id: imageId },
    });

    if (!image) {
      return json({ error: "Image not found" }, { status: 404 });
    }

    // Where this mode's result lives, so switching modes never serves the
    // other one from a cache.
    const parts = image.originalUrl.split("/");
    const sessionPart = parts[1] || "unknown";
    const imagePart = parts[2] || imageId;
    const bgRemovedKey = `uploads/${sessionPart}/${imagePart}/${mode === "all" ? "bg-removed-all" : "bg-removed"}.png`;

    if (image.bgRemovedUrl === bgRemovedKey) {
      if (!image.bgRemoved) {
        await prisma.gangSheetImage.update({ where: { id: imageId }, data: { bgRemoved: true } });
      }
      // Same shape as a fresh result: the editor prefixes "/…" paths.
      return json({ status: "already_done", bgRemovedUrl: `/api/image/${bgRemovedKey}`, mode });
    }

    // The raster the design prints from: an EPS/AI original is a vector
    // sharp cannot read, so use the PNG it was converted to at upload.
    const originalBuffer = await downloadFile(resolveRasterKey(image.originalUrl));

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
      // Local: the white around the design, or on request all white.
      resultBuffer =
        mode === "all"
          ? await removeAllWhite(originalBuffer)
          : await removeWhiteBackground(originalBuffer);
    }

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
      mode,
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

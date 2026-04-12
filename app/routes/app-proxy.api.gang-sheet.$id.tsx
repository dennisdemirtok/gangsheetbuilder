import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getPresignedDownloadUrl } from "../lib/r2.server";

/**
 * Get, update or save a specific gang sheet.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const gangSheet = await prisma.gangSheet.findUnique({
      where: { id: params.id },
      include: { images: true },
    });

    if (!gangSheet || gangSheet.shopDomain !== session.shop) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const imagesWithUrls = await Promise.all(
      gangSheet.images.map(async (img) => ({
        ...img,
        thumbnailPresignedUrl: img.thumbnailUrl
          ? await getPresignedDownloadUrl(img.thumbnailUrl).catch(() => null)
          : null,
      })),
    );

    return json({
      gangSheet: { ...gangSheet, images: imagesWithUrls },
    });
  } catch (error) {
    console.error("Gang sheet get error:", error);
    return json({ error: "Failed to load gang sheet" }, { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const gangSheetId = params.id!;

    const gangSheet = await prisma.gangSheet.findUnique({
      where: { id: gangSheetId },
    });

    if (!gangSheet || gangSheet.shopDomain !== session.shop) {
      return json({ error: "Not found" }, { status: 404 });
    }

    if (request.method !== "PUT" && request.method !== "PATCH") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json();
    const { canvasStateJson, filmType, widthMm, heightMm, images, status } =
      body;

    // Update gang sheet metadata
    const updated = await prisma.gangSheet.update({
      where: { id: gangSheetId },
      data: {
        ...(canvasStateJson !== undefined && { canvasStateJson }),
        ...(filmType !== undefined && { filmType }),
        ...(widthMm !== undefined && { widthMm }),
        ...(heightMm !== undefined && { heightMm }),
        ...(status !== undefined && { status }),
        ...(images !== undefined && { imagesCount: images.length }),
      },
    });

    // Update image positions AND link them to this gang sheet
    if (images && Array.isArray(images)) {
      for (const img of images) {
        if (!img.id) continue;

        try {
          await prisma.gangSheetImage.update({
            where: { id: img.id },
            data: {
              gangSheetId: gangSheetId, // ALWAYS link to this gang sheet
              positionX: img.positionX,
              positionY: img.positionY,
              displayWidth: img.displayWidth,
              displayHeight: img.displayHeight,
              rotation: img.rotation || 0,
              flipX: img.flipX || false,
              flipY: img.flipY || false,
              quantity: img.quantity || 1,
            },
          });
        } catch (imgErr) {
          console.warn(`Failed to update image ${img.id}:`, imgErr);
          // Image might not exist in DB (e.g. duplicated locally)
          // Skip it silently
        }
      }
    }

    // Verify images are now linked
    const linkedCount = await prisma.gangSheetImage.count({
      where: { gangSheetId },
    });

    return json({
      gangSheet: updated,
      linkedImages: linkedCount,
    });
  } catch (error) {
    console.error("Gang sheet update error:", error);
    return json(
      { error: `Failed to save: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

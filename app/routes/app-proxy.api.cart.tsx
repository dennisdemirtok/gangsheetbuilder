import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveVariantId, calculatePrice } from "../lib/pricing.server";

/**
 * Prepare gang sheet data for adding to Shopify cart.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { gangSheetId } = body;

    if (!gangSheetId) {
      return json({ error: "Missing gangSheetId" }, { status: 400 });
    }

    const gangSheet = await prisma.gangSheet.findUnique({
      where: { id: gangSheetId },
      include: { images: true },
    });

    if (!gangSheet || gangSheet.shopDomain !== session.shop) {
      return json({ error: "Not found" }, { status: 404 });
    }

    if (gangSheet.images.length === 0) {
      return json({ error: "Inga bilder på arket" }, { status: 400 });
    }

    const sizeKey = `${Math.round(gangSheet.widthMm / 10)}x${Math.round(gangSheet.heightMm / 10)}`;

    let variantId: string | null = null;
    try {
      variantId = await resolveVariantId(
        session.shop,
        sizeKey,
        gangSheet.filmType,
      );
    } catch {
      console.warn("Could not resolve variant ID for", sizeKey, gangSheet.filmType);
    }

    const price = await calculatePrice(
      session.shop,
      sizeKey,
      gangSheet.filmType,
    );

    await prisma.gangSheet.update({
      where: { id: gangSheetId },
      data: {
        status: "pending",
        priceSEK: price.totalPrice,
        imagesCount: gangSheet.images.length,
      },
    });

    return json({
      variantId,
      price: price.totalPrice,
      sizeKey,
      filmType: gangSheet.filmType,
      properties: {
        _gang_sheet_id: gangSheetId,
        _preview_url: gangSheet.previewUrl || "",
        _sheet_size: sizeKey,
        _film_type: gangSheet.filmType,
        _images_count: String(gangSheet.images.length),
      },
    });
  } catch (error) {
    console.error("Cart error:", error);
    return json(
      { error: `Cart preparation failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

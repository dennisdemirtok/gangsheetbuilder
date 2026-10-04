import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import sharp from "sharp";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { uploadFile } from "../lib/r2.server";

/**
 * A small picture of a sheet for its cart line.
 *
 * The sheet's real preview is made at export, after the order, so the cart
 * had nothing to show and the price product has no image: the line showed
 * an empty box. The builder draws the sheet small when it goes in the cart
 * and sends it here; the cart line links to it.
 *
 * Stored under uploads/, which the image proxy serves, with the time in the
 * name: the proxy caches an hour, and a sheet changed and put back in the
 * cart must not show its old picture.
 */

/** A drawn thumbnail is a few tens of kB; anything far bigger is not one. */
const MAX_BYTES = 2_000_000;

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const { gangSheetId, image } = await request.json();
    if (typeof gangSheetId !== "string" || !gangSheetId || typeof image !== "string") {
      return json({ error: "Missing gangSheetId or image" }, { status: 400 });
    }

    const match = /^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) return json({ error: "Not an image" }, { status: 400 });
    const input = Buffer.from(match[2]!, "base64");
    if (input.length === 0 || input.length > MAX_BYTES) {
      return json({ error: "Image too large" }, { status: 413 });
    }

    const sheet = await prisma.gangSheet.findUnique({
      where: { id: gangSheetId },
      select: { shopDomain: true },
    });
    if (!sheet || sheet.shopDomain !== session.shop) {
      return json({ error: "Not found" }, { status: 404 });
    }

    // Re-encoded here, so what is stored is always a small, valid WebP
    // whatever the browser sent.
    const thumb = await sharp(input)
      .resize({ width: 360, height: 1080, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    const key = `uploads/thumbs/${gangSheetId}-${Date.now()}.webp`;
    await uploadFile(key, thumb, "image/webp");
    return json({ key });
  } catch (error) {
    // A request the app proxy did not sign answers as the proxy says.
    if (error instanceof Response) throw error;
    console.error("Thumbnail error:", error);
    return json({ error: "Could not store the thumbnail" }, { status: 500 });
  }
};

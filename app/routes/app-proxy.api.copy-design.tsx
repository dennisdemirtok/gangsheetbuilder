import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { designFile } from "../lib/design-row.server";

/**
 * A design already on the sheet as a design of its own, for the builder's
 * "Lägg till i en annan storlek": a chest print and a back print of one
 * logo without uploading the file twice (#1168 uploaded two 14.7 MB PNGs
 * 16 times for six sizes).
 *
 * Every copy of an image row prints at the row's size, and the sheet's save
 * keys placements by row, so a second size needs a second row. It shares
 * the file (a removed background included) and has no place yet; the
 * sheet's save gives it one. Nothing is copied in storage.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

    const body = await request.json().catch(() => null);
    const imageId = typeof body?.imageId === "string" ? body.imageId : "";
    const row = imageId
      ? await prisma.gangSheetImage.findUnique({
          where: { id: imageId },
          include: { gangSheet: { select: { shopDomain: true } } },
        })
      : null;
    if (!row || (row.gangSheet && row.gangSheet.shopDomain !== session.shop)) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const copy = await prisma.gangSheetImage.create({
      data: { ...designFile(row), gangSheetId: null },
    });
    console.log(`[copy-design] ${copy.id} is ${row.id} (${row.originalFilename}) at another size`);
    return json({ id: copy.id });
  } catch (error) {
    console.error("[copy-design]", error);
    return json({ error: "Failed to copy design" }, { status: 500 });
  }
};

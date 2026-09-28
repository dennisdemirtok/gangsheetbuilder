import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { downloadFile } from "../lib/r2.server";
import { printFileName } from "../lib/order-status";
import archiver from "archiver";
import { PassThrough } from "stream";

/**
 * Batch download multiple gang sheet exports as a ZIP file.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) || [];
  // The order list selects whole orders: every print job of each.
  const orders = url.searchParams.get("orders")?.split(",").filter(Boolean) || [];

  if (ids.length === 0 && orders.length === 0) {
    return new Response("No IDs provided", { status: 400 });
  }

  const gangSheets = await prisma.gangSheet.findMany({
    where: {
      shopDomain: session.shop,
      ...(orders.length > 0 ? { shopifyOrderId: { in: orders } } : { id: { in: ids } }),
    },
    orderBy: { createdAt: "asc" },
    include: { exports: true },
  });

  if (gangSheets.length === 0) {
    return new Response("No orders found", { status: 404 });
  }

  // Create ZIP archive
  const archive = archiver("zip", { zlib: { level: 5 } });
  const passthrough = new PassThrough();
  archive.pipe(passthrough);

  const usedNames = new Set<string>();
  for (const gs of gangSheets) {
    for (const exp of gs.exports) {
      try {
        const buffer = await downloadFile(exp.url);
        // Two jobs of the same size in one order would overwrite each other.
        let filename = printFileName(gs, exp.format);
        for (let i = 2; usedNames.has(filename); i++) {
          filename = printFileName(gs, exp.format).replace(/(\.[^.]+)$/, `_${i}$1`);
        }
        usedNames.add(filename);
        archive.append(buffer, { name: filename });
      } catch (err) {
        console.error(`Failed to download ${exp.url}:`, err);
      }
    }

    // Only a sheet still waiting to be printed moves on. This used to set
    // every selected sheet to "downloaded", pulling printed and shipped
    // orders back into the queue.
    await prisma.gangSheet.updateMany({
      where: { id: gs.id, status: "exported" },
      data: { status: "downloaded" },
    });
  }

  await archive.finalize();

  // Convert stream to buffer for response
  const chunks: Uint8Array[] = [];
  for await (const chunk of passthrough) {
    chunks.push(chunk as Uint8Array);
  }
  const zipBuffer = Buffer.concat(chunks);

  return new Response(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="gangsheets-${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
};

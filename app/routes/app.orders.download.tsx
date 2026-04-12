import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { downloadFile } from "../lib/r2.server";
import archiver from "archiver";
import { PassThrough } from "stream";

/**
 * Batch download multiple gang sheet exports as a ZIP file.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const ids = url.searchParams.get("ids")?.split(",") || [];

  if (ids.length === 0) {
    return new Response("No IDs provided", { status: 400 });
  }

  // Load gang sheets with exports
  const gangSheets = await prisma.gangSheet.findMany({
    where: {
      id: { in: ids },
      shopDomain: session.shop,
    },
    include: { exports: true },
  });

  if (gangSheets.length === 0) {
    return new Response("No orders found", { status: 404 });
  }

  // Create ZIP archive
  const archive = archiver("zip", { zlib: { level: 5 } });
  const passthrough = new PassThrough();
  archive.pipe(passthrough);

  for (const gs of gangSheets) {
    for (const exp of gs.exports) {
      try {
        const buffer = await downloadFile(exp.url);
        const filename = `order-${gs.shopifyOrderId || gs.id.slice(0, 8)}_${gs.widthMm / 10}x${gs.heightMm / 10}cm.${exp.format}`;
        archive.append(buffer, { name: filename });
      } catch (err) {
        console.error(`Failed to download ${exp.url}:`, err);
      }
    }

    // Mark as downloaded
    await prisma.gangSheet.update({
      where: { id: gs.id },
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

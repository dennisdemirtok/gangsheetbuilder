import { Prisma } from "@prisma/client";
import sharp from "sharp";
import prisma from "../db.server";
import { packImages } from "./bin-packing.server";
import { SHEET_WIDTH_MM } from "./constants";
import { convertToRaster } from "./image-processing.server";
import { isVectorFormat } from "./job-file.server";
import { DEFAULT_PLACEMENT_GAP_MM, EDGE_MARGIN_MM } from "./placement";
import { getExportQueue, type ExportJobData } from "./queue.server";
import { downloadFile, uploadFile } from "./r2.server";

/**
 * Combine an order's cut jobs into one gang sheet.
 *
 * DTF Transfers By Size is printed and cut out one motif at a time. An order
 * of dozens of small motifs in different sizes (#1063: 47 jobs, 70 pieces)
 * is hours of cutting; on one sheet it prints as one file and the customer
 * cuts it out. The motifs are packed on a 58 cm sheet at their ordered size,
 * the way the builder packs a sheet, and the export worker draws it like any
 * builder sheet. The cut jobs stay on the order, since Shopify still fulfils
 * their lines, but point at the sheet and are no longer printed, sent or
 * counted on their own. splitSheet() undoes it.
 */

const EXPORT_DPI = 300;
const mmToPx = (mm: number) => Math.round((mm / 25.4) * EXPORT_DPI);

/** Order-level fields, the same on every job of an order: the sheet gets them too. */
const ORDER_FIELDS = [
  "orderName",
  "customerName",
  "shippingStatus",
  "bwsBookingId",
  "trackingUrl",
  "trackingNumber",
  "shippingLabelKey",
  "pickupDate",
  "shippingError",
  "shippingService",
  "shippingPrice",
  "shippingCurrency",
  "shippingBookedAt",
  "awaitingCustomerSince",
  "awaitingCustomerNote",
  "productionMailSentAt",
  "deliveredAt",
  "missedDeliveryMailSentAt",
] as const;

export type MergeResult =
  | { ok: true; sheets: { id: string; heightMm: number; jobs: number; pieces: number }[]; skipped: string[] }
  | { ok: false; error: string };

/**
 * A raster of the motif to place on the sheet. Raster uploads are used as
 * they are; a vector (EPS/AI/PDF/SVG) is drawn at its print size, which the
 * export worker cannot do for a cut job's file.
 */
async function motifRaster(
  job: { id: string; widthMm: number; heightMm: number },
  image: { originalUrl: string; originalFilename: string; widthPx: number; heightPx: number },
): Promise<{ key: string; widthPx: number; heightPx: number }> {
  const ext = (image.originalFilename.split(".").pop() || image.originalUrl.split(".").pop() || "").toLowerCase();
  if (!isVectorFormat(ext)) {
    return { key: image.originalUrl, widthPx: image.widthPx, heightPx: image.heightPx };
  }
  const source = await downloadFile(image.originalUrl);
  let png: Buffer;
  if (ext === "svg") {
    const { Resvg } = await import("@resvg/resvg-js");
    png = Buffer.from(
      new Resvg(source, { fitTo: { mode: "width", value: mmToPx(job.widthMm) } }).render().asPng(),
    );
  } else {
    // Drawn at 300 DPI of its own size, then again larger if it prints bigger.
    png = await convertToRaster(source, image.originalFilename || `motif.${ext}`, EXPORT_DPI);
    const width = (await sharp(png, { limitInputPixels: false }).metadata()).width || 0;
    const scale = width > 0 ? mmToPx(job.widthMm) / width : 1;
    if (scale > 1.05) {
      png = await convertToRaster(source, image.originalFilename || `motif.${ext}`, Math.min(2400, Math.ceil(EXPORT_DPI * scale)));
    }
  }
  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const key = `exports/${job.id}/merge-motif.png`;
  await uploadFile(key, png, "image/png");
  return { key, widthPx: meta.width || 0, heightPx: meta.height || 0 };
}

export async function mergeCutJobs(options: {
  shopDomain: string;
  shopifyOrderId: string;
  author: string;
}): Promise<MergeResult> {
  const { shopDomain, shopifyOrderId, author } = options;
  const candidates = await prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId, kind: "cut", mergedIntoId: null, status: { notIn: ["draft", "shipped"] } },
    orderBy: { createdAt: "asc" },
    include: { images: { orderBy: { createdAt: "asc" }, take: 1 } },
  });

  // Only motifs with a file and a size can be placed.
  const skipped: string[] = [];
  const jobs = candidates.filter((job) => {
    const ok = job.images.length > 0 && job.widthMm > 0 && job.heightMm > 0;
    if (!ok) skipped.push(`${job.widthMm / 10} × ${job.heightMm / 10} cm (${job.images.length ? "no size" : "no file"})`);
    return ok;
  });
  if (jobs.length < 2) {
    return { ok: false, error: "There need to be at least two cut jobs with a file to combine." };
  }

  // Film and print type are printed separately: one sheet per kind.
  const groups = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const key = `${job.printType ?? ""}|${job.filmType}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }

  const sheets: { id: string; heightMm: number; jobs: number; pieces: number }[] = [];
  for (const group of groups.values()) {
    const packed = packImages(
      group.map((job) => ({ id: job.id, width: job.widthMm, height: job.heightMm, quantity: job.lineQuantity || 1 })),
      SHEET_WIDTH_MM,
      100_000,
      DEFAULT_PLACEMENT_GAP_MM,
      EDGE_MARGIN_MM,
    );
    if (packed.overflow.length > 0) {
      const sizes = packed.overflow.map((o) => `${o.width / 10} × ${o.height / 10} cm`).join(", ");
      return { ok: false, error: `Wider than the 58 cm sheet, cannot be placed: ${sizes}.` };
    }
    const heightMm = Math.max(100, Math.ceil(packed.usedHeight / 10) * 10);
    const pieces = packed.placements.length;
    const first = group[0];

    const rasters = new Map<string, { key: string; widthPx: number; heightPx: number }>();
    for (const job of group) rasters.set(job.id, await motifRaster(job, job.images[0]));

    const orderFields = Object.fromEntries(ORDER_FIELDS.map((f) => [f, first[f]])) as Pick<
      typeof first,
      (typeof ORDER_FIELDS)[number]
    >;
    const sheet = await prisma.$transaction(async (tx) => {
      const created = await tx.gangSheet.create({
        data: {
          ...orderFields,
          sessionId: `merged-${shopifyOrderId}`,
          shopDomain,
          shopifyOrderId,
          shippingAddress: (first.shippingAddress as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          otherLineItems: (first.otherLineItems as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          kind: "gang_sheet",
          printType: first.printType,
          filmType: first.filmType,
          productTitle: first.productTitle,
          variantTitle: `Combined sheet, ${pieces} motifs`,
          lineQuantity: 1,
          widthMm: SHEET_WIDTH_MM,
          heightMm,
          imagesCount: group.length,
          status: "pending",
        },
        select: { id: true },
      });
      for (const job of group) {
        const image = job.images[0];
        const raster = rasters.get(job.id)!;
        const copies = packed.placements.filter((p) => p.id === job.id);
        const placements = copies.map((c) => ({ xMm: c.x, yMm: c.y, rotation: c.rotated ? 90 : 0 }));
        await tx.gangSheetImage.create({
          data: {
            gangSheetId: created.id,
            originalUrl: raster.key,
            thumbnailUrl: image.thumbnailUrl,
            // A drawn vector is a PNG now; the worker must not look for the vector.
            originalFilename:
              raster.key === image.originalUrl
                ? image.originalFilename
                : `${image.originalFilename.replace(/\.[^.]+$/, "")}.png`,
            mimeType: raster.key === image.originalUrl ? image.mimeType : "image/png",
            fileSizeBytes: image.fileSizeBytes,
            widthPx: raster.widthPx,
            heightPx: raster.heightPx,
            dpiX: image.dpiX,
            dpiY: image.dpiY,
            displayWidth: job.widthMm,
            displayHeight: job.heightMm,
            positionX: placements[0].xMm,
            positionY: placements[0].yMm,
            rotation: placements[0].rotation,
            quantity: placements.length,
            placementsJson: placements as Prisma.InputJsonArray,
          },
        });
      }
      await tx.gangSheet.updateMany({
        where: { id: { in: group.map((j) => j.id) } },
        data: { mergedIntoId: created.id },
      });
      await tx.gangSheetNote.create({
        data: {
          gangSheetId: created.id,
          author,
          body: `Combined ${group.length} cut jobs (${pieces} motifs) into one ${heightMm / 10} cm sheet.`,
        },
      });
      return created;
      // One row per motif: dozens of writes, longer than the 5 s default.
    }, { timeout: 60_000 });

    const jobData: ExportJobData = { gangSheetId: sheet.id, shopDomain };
    await getExportQueue().add(`export-${sheet.id}`, jobData, { jobId: `export-${sheet.id}-merge` });
    sheets.push({ id: sheet.id, heightMm, jobs: group.length, pieces });
  }

  return { ok: true, sheets, skipped };
}

/** Undo mergeCutJobs: the cut jobs are printed one by one again. */
export async function splitSheet(options: {
  shopDomain: string;
  sheetId: string;
  author: string;
}): Promise<{ ok: true; firstJobId: string } | { ok: false; error: string }> {
  const { shopDomain, sheetId, author } = options;
  const sheet = await prisma.gangSheet.findFirst({ where: { id: sheetId, shopDomain }, select: { id: true, status: true } });
  const parts = await prisma.gangSheet.findMany({
    where: { shopDomain, mergedIntoId: sheetId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!sheet || parts.length === 0) return { ok: false, error: "This sheet was not combined from cut jobs." };
  if (sheet.status === "shipped") return { ok: false, error: "The order has shipped." };

  await prisma.$transaction([
    prisma.gangSheet.updateMany({ where: { shopDomain, mergedIntoId: sheetId }, data: { mergedIntoId: null } }),
    // The combined sheet only existed to print them; its images and notes go with it.
    prisma.gangSheet.delete({ where: { id: sheetId } }),
    prisma.gangSheetNote.create({
      data: { gangSheetId: parts[0].id, author, body: `Combined sheet undone: ${parts.length} cut jobs print one by one again.` },
    }),
  ]);
  return { ok: true, firstJobId: parts[0].id };
}

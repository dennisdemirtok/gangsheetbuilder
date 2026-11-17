import { Prisma } from "@prisma/client";
import sharp from "sharp";
import prisma from "../db.server";
import { packImages } from "./bin-packing.server";
import { SHEET_WIDTH_MM } from "./constants";
import { artworkBox, isBlank } from "./image-processing.server";
import { drawForPrint, isVectorFormat } from "./job-file.server";
import { DEFAULT_PLACEMENT_GAP_MM, EDGE_MARGIN_MM } from "./placement";
import { cutJobCount } from "./print-jobs";
import { getExportQueue, type ExportJobData } from "./queue.server";
import { downloadFile, uploadFile } from "./r2.server";

/**
 * Combine an order's cut jobs into one gang sheet.
 *
 * DTF Transfers By Size is printed and cut out one motif at a time. An order
 * of dozens of small motifs in different sizes (#1063: 47 jobs, 70 pieces)
 * is hours of cutting; on one sheet it prints as one file and the customer
 * cuts it out. So does one job with many copies (#1180: 12 × 27 cm). The
 * motifs are packed on a 58 cm sheet at their ordered size, the way the
 * builder packs a sheet, and the export worker draws it like any builder
 * sheet. The cut jobs stay on the order, since Shopify still fulfils
 * their lines, but point at the sheet and are no longer printed, sent or
 * counted on their own. splitSheet() undoes it.
 */

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
  | { ok: true; sheets: { id: string; heightMm: number; jobs: number; pieces: number }[]; skipped: string[]; reshaped: string[] }
  | { ok: false; error: string };

type Motif = { key: string; widthPx: number; heightPx: number; widthMm: number; heightMm: number };

/**
 * The motif to place on the sheet, and the size it prints at.
 *
 * It keeps its own shape and is as large as fits in the ordered box, the way
 * the cut job's own print file is drawn (see fitToPrintSize). The export
 * worker stretches a picture to the size it is given, and this used to give
 * it the box: #1240's 8.7 : 1 logo, ordered as 25 × 10, 12 × 8 and 22 × 13 cm,
 * came out 3–6 times too tall. The sheet is packed by the motif, not the box,
 * so the empty part of a box takes no film.
 *
 * A picture is used whole, margin and all: the customer sized the whole file.
 * A vector (EPS/AI/PDF/SVG) is drawn at its print size and cut to its
 * artwork, since its page means nothing, which the export worker cannot do
 * for a cut job's file.
 */
export async function placeMotif(
  job: { id: string; widthMm: number; heightMm: number },
  image: { originalUrl: string; originalFilename: string },
): Promise<Motif> {
  const ext = (image.originalFilename.split(".").pop() || image.originalUrl.split(".").pop() || "").toLowerCase();
  const source = await downloadFile(image.originalUrl);
  const open = (input: Buffer) => sharp(input, { limitInputPixels: false });

  let png: Buffer | null = null;
  if (isVectorFormat(ext)) {
    const drawn = await drawForPrint(source, ext, job);
    if (await isBlank(drawn)) throw new Error("it drew nothing");
    png = await open(drawn).extract(await artworkBox(drawn)).png().toBuffer();
  } else if (((await open(source).metadata()).orientation ?? 1) > 1) {
    // A phone photo turned by its EXIF tag: the worker draws the pixels as
    // stored, the cut job's own file upright.
    png = await open(source).rotate().keepIccProfile().png().toBuffer();
  }

  const meta = await open(png ?? source).metadata();
  const widthPx = meta.width || 0;
  const heightPx = meta.height || 0;
  if (!widthPx || !heightPx) throw new Error("the file has no size");
  const mmPerPx = Math.min(job.widthMm / widthPx, job.heightMm / heightPx);
  // Not rounded: 0.1 mm off a 14 mm high logo is a visible squeeze.
  const toMm = (px: number, box: number) => Math.min(box, px * mmPerPx);

  let key = image.originalUrl;
  if (png) {
    key = `exports/${job.id}/merge-motif.png`;
    await uploadFile(key, png, "image/png");
  }
  return { key, widthPx, heightPx, widthMm: toMm(widthPx, job.widthMm), heightMm: toMm(heightPx, job.heightMm) };
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
  if (jobs.reduce((sum, job) => sum + (job.lineQuantity || 1), 0) < 2) {
    return { ok: false, error: "There need to be at least two motifs with a file to combine." };
  }

  // Every motif drawn before anything is written: one that fails stops the
  // whole combine, not half of it.
  const motifs = new Map<string, Motif>();
  for (const job of jobs) {
    try {
      motifs.set(job.id, await placeMotif(job, job.images[0]));
    } catch (error) {
      const box = `${job.widthMm / 10} × ${job.heightMm / 10} cm`;
      return { ok: false, error: `Could not draw the ${box} motif: ${(error as Error).message}` };
    }
  }

  // A motif of another shape than its box fills only part of it, like in its
  // own print file. Said on the sheet, so nobody has to measure.
  const reshaped = new Map<string, string>();
  for (const job of jobs) {
    const motif = motifs.get(job.id)!;
    if (motif.widthMm >= job.widthMm * 0.98 && motif.heightMm >= job.heightMm * 0.98) continue;
    const cm = (mm: number) => (mm / 10).toFixed(1).replace(/\.0$/, "");
    reshaped.set(job.id, `${cm(job.widthMm)} × ${cm(job.heightMm)} cm ordered, the motif is ${cm(motif.widthMm)} × ${cm(motif.heightMm)} cm`);
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
      group.map((job) => ({
        id: job.id,
        width: motifs.get(job.id)!.widthMm,
        height: motifs.get(job.id)!.heightMm,
        quantity: job.lineQuantity || 1,
      })),
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
        const motif = motifs.get(job.id)!;
        const copies = packed.placements.filter((p) => p.id === job.id);
        const placements = copies.map((c) => ({ xMm: c.x, yMm: c.y, rotation: c.rotated ? 90 : 0 }));
        const dpi = Math.round(motif.widthPx / (motif.widthMm / 25.4));
        await tx.gangSheetImage.create({
          data: {
            gangSheetId: created.id,
            originalUrl: motif.key,
            thumbnailUrl: image.thumbnailUrl,
            // A drawn vector is a PNG now; the worker must not look for the vector.
            originalFilename:
              motif.key === image.originalUrl
                ? image.originalFilename
                : `${image.originalFilename.replace(/\.[^.]+$/, "")}.png`,
            mimeType: motif.key === image.originalUrl ? image.mimeType : "image/png",
            fileSizeBytes: image.fileSizeBytes,
            widthPx: motif.widthPx,
            heightPx: motif.heightPx,
            dpiX: dpi,
            dpiY: dpi,
            // The motif's own shape, as large as fits in the box ordered.
            displayWidth: motif.widthMm,
            displayHeight: motif.heightMm,
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
          body: [
            `Combined ${cutJobCount(group.length)} (${pieces} motifs) into one ${heightMm / 10} cm sheet.`,
            ...group.flatMap((job) => (reshaped.has(job.id) ? [`Own shape: ${reshaped.get(job.id)}.`] : [])),
          ].join(" "),
        },
      });
      return created;
      // One row per motif: dozens of writes, longer than the 5 s default.
    }, { timeout: 60_000 });

    const jobData: ExportJobData = { gangSheetId: sheet.id, shopDomain };
    await getExportQueue().add(`export-${sheet.id}`, jobData, { jobId: `export-${sheet.id}-merge` });
    sheets.push({ id: sheet.id, heightMm, jobs: group.length, pieces });
  }

  return { ok: true, sheets, skipped, reshaped: [...reshaped.values()] };
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
      data: { gangSheetId: parts[0].id, author, body: `Combined sheet undone: back to ${cutJobCount(parts.length)}.` },
    }),
  ]);
  return { ok: true, firstJobId: parts[0].id };
}

import sharp from "sharp";
import prisma from "../db.server";
import { downloadFile, uploadFile } from "./r2.server";
import { artworkBox, convertToRaster, eightBitPicture, fitToPrintSize, isBlank, svgTextFonts } from "./image-processing.server";
import { motifRaster } from "./motif-cleanup.server";

/**
 * Store the file the print shop prints for a job, with a preview.
 *
 * Used when a cut job's motif is fetched after payment, and when the shop
 * replaces a customer's broken file from the order page. Vector files (EPS,
 * AI, PDF, SVG) are kept as they are — that is what prints best — and get a
 * preview rendered with Ghostscript; before, they showed "No preview" and
 * nobody could see the file was wrong until it was opened in Poland.
 */

const VECTOR = new Set(["eps", "ai", "ps", "pdf", "svg"]);

export function isVectorFormat(format: string | null | undefined): boolean {
  return VECTOR.has((format || "").toLowerCase());
}

const RASTER = new Set(["png", "jpg", "jpeg", "jfif", "webp", "tif", "tiff", "gif", "avif"]);

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  eps: "application/postscript",
  ai: "application/postscript",
  ps: "application/postscript",
  pdf: "application/pdf",
  svg: "image/svg+xml",
};

async function renderPreview(buffer: Buffer, ext: string): Promise<{ png: Buffer | null; widthPx: number; heightPx: number }> {
  try {
    if (["eps", "ai", "ps", "pdf"].includes(ext)) {
      const raster = await convertToRaster(buffer, `file.${ext}`, 150);
      const meta = await sharp(raster).metadata();
      return { png: raster, widthPx: meta.width || 0, heightPx: meta.height || 0 };
    }
    if (ext === "svg") {
      // The server's libvips is built without SVG support; resvg renders it.
      const { Resvg } = await import("@resvg/resvg-js");
      const png = new Resvg(buffer, { fitTo: { mode: "width", value: 1600 } }).render().asPng();
      return { png: Buffer.from(png), widthPx: 0, heightPx: 0 };
    }
    const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
    return { png: buffer, widthPx: meta.width || 0, heightPx: meta.height || 0 };
  } catch (error) {
    console.warn(`[job-file] No preview for .${ext}:`, (error as Error).message);
    return { png: null, widthPx: 0, heightPx: 0 };
  }
}

export async function storeJobFile(options: {
  jobId: string;
  buffer: Buffer;
  filename: string;
  contentType?: string | null;
}): Promise<{ format: string; vector: boolean; dpi: number | null; hasPreview: boolean }> {
  const { jobId, buffer } = options;
  const job = await prisma.gangSheet.findUniqueOrThrow({
    where: { id: jobId },
    select: { widthMm: true, heightMm: true, lineQuantity: true, status: true, kind: true },
  });
  // A gang sheet's file is the whole composed sheet; its list of designs
  // (what the customer placed) stays as it is when the file is swapped.
  const keepDesigns = job.kind === "gang_sheet";

  const filename = options.filename.replace(/[/\\]/g, "_").slice(0, 200) || "motif";
  const ext = (filename.split(".").pop() || "bin").toLowerCase().slice(0, 5);
  const vector = isVectorFormat(ext);
  const contentType = CONTENT_TYPES[ext] || options.contentType || "application/octet-stream";

  // A new key per upload, so a replaced file never serves a cached old one.
  const stamp = Date.now().toString(36);
  const fileKey = `exports/${jobId}/motif-${stamp}.${ext}`;
  await uploadFile(fileKey, buffer, contentType);

  const preview = await renderPreview(buffer, ext);
  let previewKey: string | null = null;
  if (preview.png) {
    // The order page judges the file's colours by this preview.
    const webp = await sharp(await eightBitPicture(preview.png), { limitInputPixels: false })
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    previewKey = `exports/${jobId}/preview-${stamp}.webp`;
    await uploadFile(previewKey, webp, "image/webp");
  }

  // Resolution at the ordered print width; a vector has no limit.
  const dpi =
    !vector && preview.widthPx > 0 && job.widthMm > 0
      ? Math.round(preview.widthPx / (job.widthMm / 25.4))
      : null;

  const designUpdates = keepDesigns
    ? []
    : [
    prisma.gangSheetImage.deleteMany({ where: { gangSheetId: jobId } }),
    prisma.gangSheetImage.create({
      data: {
        gangSheetId: jobId,
        originalUrl: fileKey,
        thumbnailUrl: previewKey,
        originalFilename: filename,
        mimeType: contentType,
        fileSizeBytes: buffer.length,
        widthPx: vector ? 0 : preview.widthPx,
        heightPx: vector ? 0 : preview.heightPx,
        dpiX: dpi,
        dpiY: dpi,
        displayWidth: job.widthMm || null,
        displayHeight: job.heightMm || null,
        quantity: job.lineQuantity || 1,
      },
    }),
      ];

  await prisma.$transaction([
    ...designUpdates,
    prisma.gangSheetExport.deleteMany({ where: { gangSheetId: jobId } }),
    prisma.gangSheetExport.create({
      data: {
        gangSheetId: jobId,
        format: ext,
        url: fileKey,
        fileSizeBytes: buffer.length,
        dpi: dpi ?? 300,
      },
    }),
    prisma.gangSheet.update({
      where: { id: jobId },
      data: {
        exportUrl: fileKey,
        previewUrl: previewKey,
        ...(keepDesigns ? {} : { imagesCount: 1 }),
        ...(job.status === "pending" || job.status === "draft" ? { status: "exported" } : {}),
      },
    }),
  ]);

  return { format: ext, vector, dpi, hasPreview: Boolean(previewKey) };
}

/** 600 DPI as long as the print file stays this many pixels; never under 300. */
const MAX_VECTOR_PIXELS = 60_000_000;

/**
 * A vector cut job drawn for print, with the motif at the ordered size. Its
 * page says nothing about that: logo sites hand out 2500 px squares with the
 * logo somewhere inside, so a first look finds the motif and sets the scale.
 */
async function drawForPrint(
  buffer: Buffer,
  format: string,
  box: { widthMm: number; heightMm: number },
): Promise<Buffer> {
  const name = `motif.${format}`;
  const first = await sharp(await motifRaster(buffer, name, 96), { limitInputPixels: false }).metadata();
  const lookDpi = (96 * 1500) / Math.max(first.width, first.height);

  const art = await artworkBox(await motifRaster(buffer, name, lookDpi));
  const mmPerPx = Math.min(box.widthMm / art.width, box.heightMm / art.height);
  const squareInches = ((art.width * mmPerPx) / 25.4) * ((art.height * mmPerPx) / 25.4);
  const dpi = Math.max(300, Math.min(600, Math.sqrt(MAX_VECTOR_PIXELS / squareInches)));
  return motifRaster(buffer, name, (lookDpi * dpi * mmPerPx) / 25.4);
}

/**
 * Make a cut job's print file measure the size the job says, just before it
 * leaves for the print shop: by then every replaced file and changed size is
 * in. The old file stays in storage. A sheet is left alone, its file is
 * composed at size. A vector becomes a PNG too, like a roll's designs and
 * #1161's logos: its page size means nothing, and in Poland a motif drawn
 * here cannot lose a font or be scaled by eye.
 *
 * The file always measures the size ordered, and the job's size stays as the
 * customer ordered it (see fitToPrintSize).
 *
 * Returns what we should know: a vector that had to stay as it is (such a
 * file can still be fine in their software, so it does not stop the order),
 * or a picture of another shape than the box, which fills only part of it.
 */
export async function setPrintSize(jobId: string): Promise<string | null> {
  const job = await prisma.gangSheet.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      exports: { orderBy: { createdAt: "desc" }, take: 1 },
      images: { select: { originalFilename: true }, take: 1 },
    },
  });
  const file = job.exports[0];
  if (job.kind !== "cut" || !job.widthMm || !job.heightMm || !file) return null;
  const format = file.format.toLowerCase();
  const vector = isVectorFormat(format);
  if (!vector && !RASTER.has(format)) return null;

  const ordered = `${job.widthMm / 10} × ${job.heightMm / 10} cm`;
  let picture = await downloadFile(file.url);
  if (vector) {
    // The server has none of the customer's fonts (#1154 printed symbols).
    if (format === "svg" && svgTextFonts(picture)) {
      return `The ${ordered} SVG has text that is not outlined, so it went as it is, with the size in the email.`;
    }
    try {
      picture = await drawForPrint(picture, format, job);
      if (await isBlank(picture)) throw new Error("it drew nothing");
    } catch (error) {
      console.warn(`[job-file] Could not draw ${file.url}:`, (error as Error).message);
      return `The ${ordered} ${format.toUpperCase()} could not be drawn here, so it went as it is, with the size in the email.`;
    }
  }

  // The file always measures the size ordered; the job's size is never
  // changed here. #1204's A5 sheets became 14.4 × 21 cm when it was.
  const fitted = await fitToPrintSize(picture, job, { trimMargin: vector });
  if (!vector && !fitted.changed) return null;

  // A picture of another shape than the box prints as large as fits, the rest
  // of the box transparent. Worth a look before the print shop gets it.
  const motif = `${(fitted.motifWidthMm / 10).toFixed(1)} × ${(fitted.motifHeightMm / 10).toFixed(1)} cm`;
  const otherShape = fitted.motifWidthMm < job.widthMm * 0.98 || fitted.motifHeightMm < job.heightMm * 0.98;

  const name = (job.images[0]?.originalFilename || "motif").replace(/\.[^.]+$/, "");
  await storeJobFile({ jobId, buffer: fitted.png, filename: `${name}.png`, contentType: "image/png" });
  await prisma.gangSheetNote.create({
    data: {
      gangSheetId: jobId,
      author: job.shopDomain,
      body: `Print size set in the file: ${ordered} at ${Math.round(fitted.dpi)} DPI${
        otherShape ? ` (the picture is ${motif} of it, the rest transparent)` : ""
      } · was ${file.url}`,
    },
  });
  return otherShape
    ? `The ${ordered} file is the size ordered, but the picture has another shape: it fills ${motif} of it and the rest is transparent.`
    : null;
}

/**
 * The fonts of live <text> in a job's SVG designs, or null when none has
 * any (see svgTextFonts). The upload keeps the SVG as original.svg beside
 * the PNG it prints from; a file stored here is the SVG itself.
 */
export async function liveTextFonts(
  designs: { originalUrl: string; originalFilename: string }[],
): Promise<string[] | null> {
  const keys = designs
    .filter((d) => /\.svg$/i.test(d.originalFilename))
    .map((d) =>
      /\.svg$/i.test(d.originalUrl)
        ? d.originalUrl
        : `${d.originalUrl.slice(0, d.originalUrl.lastIndexOf("/") + 1)}original.svg`,
    );
  const found = await Promise.all(
    [...new Set(keys)].map((key) => downloadFile(key).then(svgTextFonts, () => null)),
  );
  const texts = found.filter((fonts): fonts is string[] => fonts !== null);
  return texts.length > 0 ? [...new Set(texts.flat())] : null;
}

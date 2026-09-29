import sharp from "sharp";
import prisma from "../db.server";
import { uploadFile } from "./r2.server";
import { convertToRaster } from "./image-processing.server";

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
    const webp = await sharp(preview.png, { limitInputPixels: false })
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

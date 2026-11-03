import sharp from "sharp";
import prisma from "../db.server";
import { downloadFile, uploadFile, getPresignedDownloadUrl } from "./r2.server";
import { storeJobFile, isVectorFormat } from "./job-file.server";
import { resolveRasterKey } from "./placement";
import { generateThumbnail } from "./image-processing.server";
import { getExportQueue, type ExportJobData } from "./queue.server";
import {
  motifRaster,
  removeMotifBackground,
  sharpenJudgeSize,
  sharpenLogo,
  type BackgroundResult,
  type SharpenResult,
} from "./motif-cleanup.server";

/**
 * The order page's "Remove background" and "Sharpen logo": the fix is made
 * and shown first (before and after), and only "Use" changes what prints.
 *
 * A cut job gets a new print file through storeJobFile, like "Replace
 * file"; the old one stays in storage and a note records the swap. A
 * design on a gang sheet is fixed on every copy of it on that sheet, and
 * the sheet's print file is made again.
 */

export type FixTool = "background" | "sharpen";

const SUFFIX: Record<FixTool, string> = { background: "utan-bakgrund", sharpen: "skarp" };

type Found =
  | { ok: false; error: string }
  | {
      ok: true;
      job: { id: string; kind: string; widthMm: number; heightMm: number; shopDomain: string; sentToPrintShopAt: Date | null };
      /** The rows the fix applies to: the cut job's motif, or every copy of a design. */
      rows: { id: string; originalUrl: string; originalFilename: string; bgRemoved: boolean; bgRemovedUrl: string | null; displayWidth: number | null; displayHeight: number | null }[];
      sourceKey: string;
      filename: string;
    };

async function findTarget(shop: string, jobId: string, designId: string | null): Promise<Found> {
  const job = await prisma.gangSheet.findFirst({
    where: { id: jobId, shopDomain: shop },
    include: { images: true },
  });
  if (!job) return { ok: false, error: "Print job not found." };

  if (job.kind === "cut") {
    const image = job.images[0];
    const key = job.exportUrl ?? image?.originalUrl;
    if (!key) return { ok: false, error: "This job has no file yet." };
    return { ok: true, job, rows: image ? [image] : [], sourceKey: key, filename: image?.originalFilename ?? key.split("/").pop()! };
  }

  const design = job.images.find((i) => i.id === designId);
  if (!design) return { ok: false, error: "Design not found on this sheet." };
  // A vector design is drawn again at its print size: it is never soft.
  const ext = (design.originalFilename.split(".").pop() || "").toLowerCase();
  if (isVectorFormat(ext)) return { ok: false, error: "A vector design prints sharp already; change it in the builder." };
  return {
    ok: true,
    job,
    rows: job.images.filter((i) => i.originalUrl === design.originalUrl),
    sourceKey: resolveRasterKey(design.bgRemoved && design.bgRemovedUrl ? design.bgRemovedUrl : design.originalUrl),
    filename: design.originalFilename,
  };
}

/** Long side in px for 600 DPI at the largest size it prints, within reason. */
function targetLongSide(sizesMm: number[]): number {
  const mm = Math.max(10, ...sizesMm);
  return Math.round(Math.min(10_000, Math.max(1500, (mm / 25.4) * 600)));
}

/** The picture to work on; a vector drawn at about `longSidePx`. */
async function sourceRaster(buffer: Buffer, filename: string, longSidePx: number): Promise<Buffer> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (!isVectorFormat(ext)) return motifRaster(buffer, filename);
  const probe = await sharp(await motifRaster(buffer, filename, 72)).metadata();
  const long = Math.max(probe.width || 0, probe.height || 0) || 1000;
  return motifRaster(buffer, filename, Math.round(Math.min(1200, Math.max(150, (72 * longSidePx) / long))));
}

async function previewUrl(png: Buffer): Promise<string> {
  const webp = await sharp(png, { limitInputPixels: false })
    .resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  return `data:image/webp;base64,${webp.toString("base64")}`;
}

export function refusal(result: BackgroundResult | SharpenResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "transparent":
      return "The file already has a transparent background.";
    case "no_background":
      return "There is no one-colour background around the motif to remove.";
    case "photo":
      return "This looks like a photo, a painting or a gradient: tracing would flatten it. Only flat logos can be sharpened.";
    case "empty":
      return "There is nothing in the file to sharpen.";
  }
}

export async function previewFix(options: {
  shop: string;
  jobId: string;
  designId: string | null;
  tool: FixTool;
}): Promise<{ ok: true; key: string; before: string; after: string; summary: string; warning: string | null } | { ok: false; error: string }> {
  const found = await findTarget(options.shop, options.jobId, options.designId);
  if (!found.ok) return found;
  const { job, rows } = found;

  const sizes =
    job.kind === "cut"
      ? [job.widthMm, job.heightMm]
      : rows.flatMap((r) => [r.displayWidth ?? 0, r.displayHeight ?? 0]);
  const longSide = targetLongSide(sizes);
  const file = await downloadFile(found.sourceKey);
  const judgeAt = sharpenJudgeSize(file, found.sourceKey);
  if (options.tool === "sharpen" && judgeAt === null) {
    return { ok: false, error: "The file is a vector already: it prints sharp at any size." };
  }
  const raster = await sourceRaster(file, found.sourceKey, longSide);

  let png: Buffer;
  let summary: string;
  if (options.tool === "background") {
    // A design on a sheet keeps its canvas (no trim), so it stays where it was placed.
    const result = await removeMotifBackground(raster, job.kind !== "cut");
    if (!result.ok) return { ok: false, error: refusal(result) };
    png = result.png;
    summary = "Background removed";
  } else {
    const result = await sharpenLogo(raster, longSide, judgeAt ?? undefined);
    console.log(`[motif-fix] ${found.filename}: sharpen`, result.ok ? result.colors : result.reason, result.stats);
    if (!result.ok) return { ok: false, error: refusal(result) };
    png = result.png;
    summary = `Traced in ${result.colors.length} colour${result.colors.length === 1 ? "" : "s"}`;
  }

  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const stamp = Date.now().toString(36);
  const key =
    job.kind === "cut"
      ? `exports/${job.id}/fix-${options.tool}-${stamp}.png`
      : `${rows[0]!.originalUrl.slice(0, rows[0]!.originalUrl.lastIndexOf("/") + 1)}fix-${options.tool}-${stamp}.png`;
  await uploadFile(key, png, "image/png");

  return {
    ok: true,
    key,
    before: await previewUrl(raster),
    after: await previewUrl(png),
    summary: `${summary} · ${meta.width} × ${meta.height} px`,
    warning: job.sentToPrintShopAt ? "This order was already sent to the print shop: send it again after the change." : null,
  };
}

export async function applyFix(options: {
  shop: string;
  jobId: string;
  designId: string | null;
  tool: FixTool;
  key: string;
  author: string;
}): Promise<{ ok: true; notice: string } | { ok: false; error: string }> {
  const found = await findTarget(options.shop, options.jobId, options.designId);
  if (!found.ok) return found;
  const { job, rows } = found;
  if (!options.key.includes(`/fix-${options.tool}-`) || !options.key.endsWith(".png")) {
    return { ok: false, error: "Make the preview again." };
  }
  const expected =
    job.kind === "cut" ? `exports/${job.id}/` : rows[0]!.originalUrl.slice(0, rows[0]!.originalUrl.lastIndexOf("/") + 1);
  if (!options.key.startsWith(expected)) return { ok: false, error: "Make the preview again." };

  const png = await downloadFile(options.key);
  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const base = found.filename.replace(/\.[^.]+$/, "").slice(0, 120);
  const filename = `${base}-${SUFFIX[options.tool]}.png`;
  const what = options.tool === "background" ? "Background removed" : "Logo sharpened";

  if (job.kind === "cut") {
    // Without its margin the motif fills the size ordered: the longer side
    // as ordered, the other from the new shape. "The circle should be
    // 70 mm" (#1153) is then 70 mm, not 70 mm with white around it.
    let size = "";
    if (options.tool === "background") {
      const ratio = w / h;
      const widthMm = ratio >= job.widthMm / job.heightMm ? job.widthMm : Math.round(job.heightMm * ratio);
      const heightMm = ratio >= job.widthMm / job.heightMm ? Math.round(job.widthMm / ratio) : job.heightMm;
      if (widthMm !== job.widthMm || heightMm !== job.heightMm) {
        await prisma.gangSheet.update({ where: { id: job.id }, data: { widthMm, heightMm } });
        size = ` · now ${widthMm / 10} × ${heightMm / 10} cm`;
      }
    }
    await storeJobFile({ jobId: job.id, buffer: png, filename, contentType: "image/png" });
    await prisma.gangSheetNote.create({
      data: { gangSheetId: job.id, author: options.author, body: `${what}: ${filename} (was ${found.filename})${size}` },
    });
    return { ok: true, notice: `${what}${size}` };
  }

  // A design on a gang sheet: every copy of it, then the sheet again.
  if (options.tool === "background") {
    await prisma.gangSheetImage.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { bgRemoved: true, bgRemovedUrl: options.key },
    });
  } else {
    const dir = options.key.slice(0, options.key.lastIndexOf("/") + 1);
    const thumbKey = `${dir}thumbnail-${options.key.split("/").pop()!.replace(/\.png$/, "")}.webp`;
    await uploadFile(thumbKey, await generateThumbnail(png), "image/webp");
    await prisma.gangSheetImage.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        originalUrl: options.key,
        thumbnailUrl: thumbKey,
        originalFilename: filename,
        mimeType: "image/png",
        fileSizeBytes: png.length,
        widthPx: w,
        heightPx: h,
        dpiX: 300,
        dpiY: 300,
        bgRemoved: false,
        bgRemovedUrl: null,
      },
    });
  }
  await prisma.gangSheetNote.create({
    data: {
      gangSheetId: job.id,
      author: options.author,
      body: `${what} on ${rows.length} cop${rows.length === 1 ? "y" : "ies"} of ${found.filename}${
        options.tool === "sharpen" ? ` (was ${rows[0]!.originalUrl})` : ""
      }. Print file made again.`,
    },
  });
  const data: ExportJobData = { gangSheetId: job.id, shopDomain: job.shopDomain };
  await getExportQueue().add(`export-${job.id}`, data, { jobId: `export-${job.id}-fix-${Date.now().toString(36)}` });
  return { ok: true, notice: `${what} on ${rows.length} cop${rows.length === 1 ? "y" : "ies"}. The print file is being made again.` };
}

/** The sheet's designs, one row per uploaded file, for the fix list. */
export async function listSheetDesigns(shop: string, jobId: string) {
  const job = await prisma.gangSheet.findFirst({
    where: { id: jobId, shopDomain: shop, kind: "gang_sheet" },
    include: { images: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) return [];
  const bySource = new Map<string, (typeof job.images)[number][]>();
  for (const img of job.images) {
    if (img.positionX == null) continue;
    const list = bySource.get(img.originalUrl);
    if (list) list.push(img);
    else bySource.set(img.originalUrl, [img]);
  }
  return Promise.all(
    [...bySource.values()].slice(0, 40).map(async (copies) => {
      const first = copies[0]!;
      const largest = Math.max(...copies.map((c) => c.displayWidth ?? 0));
      const ext = (first.originalFilename.split(".").pop() || "").toLowerCase();
      return {
        id: first.id,
        filename: first.originalFilename,
        copies: copies.reduce((s, c) => s + (c.quantity || 1), 0),
        widthMm: Math.round(largest),
        dpi: first.widthPx > 0 && largest > 0 ? Math.round(first.widthPx / (largest / 25.4)) : null,
        vector: isVectorFormat(ext),
        bgRemoved: first.bgRemoved && Boolean(first.bgRemovedUrl),
        thumbnail: await getPresignedDownloadUrl(
          (first.bgRemoved && first.bgRemovedUrl) || first.thumbnailUrl || resolveRasterKey(first.originalUrl),
        ).catch(() => null),
      };
    }),
  );
}

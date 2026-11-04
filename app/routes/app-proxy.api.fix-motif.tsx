import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { v4 as uuidv4 } from "uuid";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { downloadFile, uploadFile, storageKey } from "../lib/r2.server";
import { validateFile } from "../lib/file-validation.server";
import { generateThumbnail } from "../lib/image-processing.server";
import { resolveRasterKey } from "../lib/placement";
import { isVectorFormat } from "../lib/job-file.server";
import {
  motifRaster,
  removeMotifBackground,
  removeMotifColor,
  sharpenJudgeSize,
  sharpenLogo,
  type BackgroundResult,
  type SharpenResult,
} from "../lib/motif-cleanup.server";

/**
 * The customer's own "Gör loggan skarp" and "Ta bort bakgrunden".
 *
 * From the builder (JSON, `imageId`): the design is traced and stored as a
 * new upload, which the editor puts in place of the old one on every copy.
 * Nothing changes until the customer has seen it and chosen it.
 *
 * From the By Size page (multipart, `file`): the file is fixed and sent
 * back as a PNG, which the page puts in its file field. PDF, EPS and AI
 * included; the browser can clean only pictures it can read. `tool`:
 * "sharpen", "background" (from the edge; X-Motif-Inside says how much of
 * the background's colour is still shut in by the motif) or
 * "background-all" (that colour everywhere).
 */

const MESSAGES: Record<string, string> = {
  photo:
    "Det här ser ut som ett foto, en målning eller en färgtoning. Sådant kan inte göras skarpt automatiskt, bara platta logotyper.",
  empty: "Filen verkar vara tom.",
  transparent: "Bilden har redan transparent bakgrund.",
  no_background: "Vi hittar ingen enfärgad bakgrund runt motivet att ta bort.",
  nothing_inside: "Det finns inget vitt kvar inuti motivet att ta bort.",
  vector: "Filen är redan en vektor och trycks skarpt i alla storlekar.",
};

function refused(result: BackgroundResult | SharpenResult) {
  const reason = result.ok ? "" : result.reason;
  return json({ error: reason, message: MESSAGES[reason] ?? "Det gick inte att fixa filen." }, { status: 422 });
}

/** Long side in px for `dpi` at the size it prints, within reason. */
function longSideFor(mm: number, dpi: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, (mm / 25.4) * dpi)));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      return fixFile(await request.formData());
    }
    return fixDesign(await request.json());
  } catch (error) {
    console.error("[fix-motif]", error);
    return json(
      { error: "failed", message: "Det gick inte att fixa filen just nu. Försök igen, eller skriv i kommentaren så hjälper vi dig." },
      { status: 500 },
    );
  }
};

async function fixDesign(body: { imageId?: string; useBgRemoved?: boolean; longSideMm?: number }) {
  const image = body.imageId ? await prisma.gangSheetImage.findUnique({ where: { id: body.imageId } }) : null;
  if (!image) return json({ error: "not_found", message: "Motivet hittades inte." }, { status: 404 });
  const ext = (image.originalFilename.split(".").pop() || "").toLowerCase();
  if (isVectorFormat(ext)) return json({ error: "vector", message: "Motivet är redan en vektor och trycks skarpt." }, { status: 422 });

  const sourceKey = resolveRasterKey(body.useBgRemoved && image.bgRemovedUrl ? image.bgRemovedUrl : image.originalUrl);
  const raster = await motifRaster(await downloadFile(sourceKey), sourceKey);
  // 600 DPI at the largest size it is placed, so it stays sharp if made larger.
  const mm = Number(body.longSideMm) > 0 ? Number(body.longSideMm) : 300;
  const result = await sharpenLogo(raster, longSideFor(mm, 600, 2000, 8000));
  console.log(`[fix-motif] ${image.originalFilename}: sharpen`, result.ok ? result.colors : result.reason, result.stats);
  if (!result.ok) return refused(result);

  // Stored like an upload of the same session, so the sheet saves it as any design.
  const sessionId = image.originalUrl.split("/")[1] || "fixed";
  const imageId = uuidv4();
  const originalKey = storageKey(sessionId, imageId, "original", "png");
  const thumbnailKey = storageKey(sessionId, imageId, "thumbnail", "webp");
  const thumbnail = await generateThumbnail(result.png);
  const { width, height } = await import("sharp").then((m) => m.default(result.png, { limitInputPixels: false }).metadata());
  await Promise.all([
    uploadFile(originalKey, result.png, "image/png"),
    uploadFile(thumbnailKey, thumbnail, "image/webp"),
  ]);
  const filename = `${image.originalFilename.replace(/\.[^.]+$/, "").slice(0, 120)}-skarp.png`;
  const row = await prisma.gangSheetImage.create({
    data: {
      gangSheetId: null,
      originalUrl: originalKey,
      thumbnailUrl: thumbnailKey,
      originalFilename: filename,
      mimeType: "image/png",
      fileSizeBytes: result.png.length,
      widthPx: width || 0,
      heightPx: height || 0,
      dpiX: 300,
      dpiY: 300,
      bgRemoved: true,
    },
  });

  return json({
    id: row.id,
    originalUrl: `/api/image/${originalKey}`,
    thumbnailUrl: `data:image/webp;base64,${thumbnail.toString("base64")}`,
    width: row.widthPx,
    height: row.heightPx,
    filename,
    colors: result.colors,
  });
}

async function fixFile(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "missing", message: "Ingen fil." }, { status: 400 });
  if (file.size > 60 * 1024 * 1024) return json({ error: "too_large", message: "Filen är större än 60 MB." }, { status: 400 });
  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = file.name || "motiv";
  const validation = await validateFile(buffer, filename);
  if (!validation.valid) return json({ error: "invalid", message: validation.error }, { status: 400 });

  // The size chosen on the page; a vector is drawn for 300 DPI at it.
  const widthCm = Number(form.get("widthCm")) || 0;
  const heightCm = Number(form.get("heightCm")) || 0;
  const longMm = Math.max(widthCm, heightCm) * 10 || 300;
  const target = longSideFor(longMm, 300, 1500, 6000);
  let raster: Buffer;
  if (isVectorFormat(validation.extension)) {
    const sharp = (await import("sharp")).default;
    const probe = await sharp(await motifRaster(buffer, filename, 72), { limitInputPixels: false }).metadata();
    const long = Math.max(probe.width || 0, probe.height || 0) || 1000;
    raster = await motifRaster(buffer, filename, Math.round(Math.min(1200, Math.max(72, (72 * target) / long))));
  } else {
    raster = await motifRaster(buffer, filename);
  }

  const headers: Record<string, string> = { "Content-Type": "image/png", "Cache-Control": "no-store" };
  let png: Buffer;
  if (form.get("tool") === "sharpen") {
    const judgeAt = sharpenJudgeSize(buffer, filename);
    if (judgeAt === null) return json({ error: "vector", message: MESSAGES.vector }, { status: 422 });
    const result = await sharpenLogo(raster, Math.max(target, 3000), judgeAt);
    console.log(`[fix-motif] ${filename}: sharpen`, result.ok ? result.colors : result.reason, result.stats);
    if (!result.ok) return refused(result);
    png = result.png;
    headers["X-Motif-Colors"] = String(result.colors.length);
  } else {
    // "background-all": the background's colour also inside the motif, which
    // the page offers when the first try leaves some (X-Motif-Inside).
    const all = form.get("tool") === "background-all";
    const result = all ? await removeMotifColor(raster) : await removeMotifBackground(raster);
    if (!result.ok) return refused(result);
    png = result.png;
    headers["X-Motif-Inside"] = result.inside.toFixed(3);
    if (result.color) headers["X-Motif-Bg"] = "#" + result.color.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    if (all) console.log(`[fix-motif] ${filename}: background everywhere`);
  }
  return new Response(new Uint8Array(png), { status: 200, headers });
}

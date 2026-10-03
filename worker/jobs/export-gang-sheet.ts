import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  computeCopyPlacements,
  parseStoredPlacements,
  resolveRasterKey,
} from "../../app/lib/placement";
import { storeJobFile } from "../../app/lib/job-file.server";
import {
  convertToRaster,
  removeAllOfColor,
  removeBackground,
  trimTransparentEdges,
} from "../../app/lib/image-processing.server";

const prisma = new PrismaClient();

interface ExportJobData {
  gangSheetId: string;
  shopDomain: string;
}

const EXPORT_DPI = 300;

function mmToPx(mm: number, dpi: number = EXPORT_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}

function getS3Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

const BUCKET = process.env.R2_BUCKET_NAME || "gangsheet-files";

async function downloadFromR2(key: string): Promise<Buffer> {
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

/**
 * Render a single placed image per the shared placement contract:
 * resize to unrotated display size → flip/flop (object space) →
 * rotate with transparent background. The resulting buffer IS the
 * axis-aligned bounding box of the placed image.
 */
async function renderPlacedImage(
  buffer: Buffer,
  widthPx: number,
  heightPx: number,
  rotation: number,
  flipX: boolean,
  flipY: boolean,
): Promise<Buffer> {
  // Pass 1: resize to the unrotated display size.
  const resized = await sharp(buffer, { limitInputPixels: false })
    .resize(widthPx, heightPx, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  if (!flipX && !flipY && rotation % 360 === 0) {
    return resized;
  }

  // Pass 2: flip/flop then rotate. sharp always applies flip/flop before
  // rotation within a pipeline, matching Fabric.js flip-then-rotate order.
  let processed = sharp(resized, { limitInputPixels: false });
  if (flipX) processed = processed.flop();
  if (flipY) processed = processed.flip();
  if (rotation % 360 !== 0) {
    processed = processed.rotate(rotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  return processed.png().toBuffer();
}

const MAX_MOTIF_BYTES = 200 * 1024 * 1024;

/**
 * A cut job (DTF Transfers By Size): nothing to compose. Copy the customer's
 * motif from Shopify's CDN into file storage so it downloads like any print
 * file, and make a preview when the format allows one.
 */
async function importCutMotif(
  gangSheet: {
    id: string;
    sourceFileUrl: string | null;
    widthMm: number;
    heightMm: number;
    lineQuantity: number | null;
  },
): Promise<void> {
  if (!gangSheet.sourceFileUrl) {
    // No file on the order: still the print shop's job, they need to see it.
    await prisma.gangSheet.update({
      where: { id: gangSheet.id },
      data: { status: "exported" },
    });
    return;
  }

  const source = new URL(gangSheet.sourceFileUrl);
  if (source.protocol !== "https:" || source.hostname !== "cdn.shopify.com") {
    throw new Error(`Refusing to download motif from ${source.hostname}`);
  }

  const res = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Motif download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_MOTIF_BYTES) throw new Error("Motif is larger than 200 MB");

  const originalName = decodeURIComponent(source.pathname.split("/").pop() || "motif");
  await storeJobFile({
    jobId: gangSheet.id,
    buffer,
    filename: originalName,
    contentType: res.headers.get("content-type"),
  });
}

export async function exportGangSheetJob(data: ExportJobData): Promise<void> {
  const gangSheet = await prisma.gangSheet.findUniqueOrThrow({
    where: { id: data.gangSheetId },
    include: { images: true },
  });

  // A cut job, or a roll ordered by hand without a builder sheet: the file
  // is the customer's (or uploaded on the order page), not composed here.
  if (gangSheet.kind === "cut" || gangSheet.images.length === 0) {
    await importCutMotif(gangSheet);
    return;
  }

  const canvasWidthPx = mmToPx(gangSheet.widthMm);
  const canvasHeightPx = mmToPx(gangSheet.heightMm);

  // Prepare composite inputs
  const compositeInputs: sharp.OverlayOptions[] = [];

  for (const image of gangSheet.images) {
    if (
      image.positionX == null ||
      image.positionY == null ||
      image.displayWidth == null ||
      image.displayHeight == null
    ) {
      continue;
    }

    // Vector originals (EPS/AI/PS) are resolved to their rasterized PNG.
    // The background-free version only when the customer chose it.
    const imageKey = resolveRasterKey(
      image.bgRemoved && image.bgRemovedUrl ? image.bgRemovedUrl : image.originalUrl,
    );
    let buffer = await downloadFromR2(imageKey);

    const targetWidth = mmToPx(image.displayWidth);
    const targetHeight = mmToPx(image.displayHeight);

    // A vector (EPS/AI/PS/SVG) was rendered once at upload — EPS at its own
    // size and 300 DPI, SVG at up to 8000 px — and cut to its artwork.
    // Printed larger, that picture is stretched: #1024 printed a vector
    // logo at 114 DPI. Draw it again from the vector at the size it is
    // printed, cut the same way, and take the background off again if the
    // customer chose that. The database points at the rendered PNG; the
    // vector sits beside it as original.<ext>.
    const ext = (image.originalFilename?.split(".").pop() || "").toLowerCase();
    const dir = image.originalUrl.slice(0, image.originalUrl.lastIndexOf("/") + 1);
    const vectorKey = ["eps", "ai", "ps", "svg"].includes(ext) ? `${dir}original.${ext}` : null;
    const usesBgRemoved = Boolean(image.bgRemoved && image.bgRemovedUrl);
    const scale = image.widthPx > 0 ? targetWidth / image.widthPx : 1;
    if (vectorKey && scale > 1.05) {
      try {
        const original = await downloadFromR2(vectorKey);
        let render: Buffer;
        if (ext === "svg") {
          // Same density rule as the upload, scaled up to the print size.
          const base = await sharp(original).metadata();
          const longSide = Math.max(base.width || 0, base.height || 0) || 1000;
          const uploadDensity = Math.max(72, Math.min(300, (72 * 8000) / longSide));
          const density = Math.min(uploadDensity * scale, (72 * 20000) / longSide);
          render = await sharp(original, { density, limitInputPixels: false }).png().toBuffer();
        } else {
          const dpi = Math.min(2400, Math.ceil(300 * scale));
          render = await convertToRaster(original, image.originalFilename || `design.${ext}`, dpi);
        }
        const trimmed = await trimTransparentEdges(render);
        if (trimmed.trimmed) render = trimmed.buffer;

        // Only if it is the same picture the customer placed: same shape as
        // the stored render. Anything else prints the stored raster.
        const meta = await sharp(render, { limitInputPixels: false }).metadata();
        const storedRatio = image.widthPx / Math.max(1, image.heightPx);
        const renderRatio = (meta.width || 1) / Math.max(1, meta.height || 1);
        if (Math.abs(renderRatio - storedRatio) / storedRatio < 0.02) {
          if (usesBgRemoved) {
            render = /bg-removed-all\.png$/.test(image.bgRemovedUrl!)
              ? await removeAllOfColor(render)
              : await removeBackground(render);
          }
          buffer = render;
          console.log(
            `[export] ${image.originalFilename}: drawn from the vector at ${meta.width}px for ${Math.round(image.displayWidth)} mm`,
          );
        } else {
          console.warn(
            `[export] ${image.originalFilename}: vector render ${renderRatio.toFixed(3)} vs placed ${storedRatio.toFixed(3)} — using the upload raster`,
          );
        }
      } catch (err) {
        console.warn(
          `[export] Could not re-render ${image.originalFilename} from the vector, using the upload raster:`,
          (err as Error).message,
        );
      }
    }

    // One placement per copy using the placements saved by the editor —
    // each with its own rotation, since the packer turns single copies.
    const { placements, skipped } = computeCopyPlacements(
      {
        positionX: image.positionX,
        positionY: image.positionY,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
        rotation: image.rotation,
        quantity: image.quantity,
        placements: parseStoredPlacements(image.placementsJson),
      },
      gangSheet.widthMm,
      gangSheet.heightMm,
    );

    if (skipped > 0) {
      console.warn(
        `[export] Gang sheet ${data.gangSheetId}: skipped ${skipped} copies of "${image.originalFilename}" that exceed the sheet bottom`,
      );
    }

    // Render the design once per rotation in use, not once per copy.
    const rendered = new Map<number, { buffer: Buffer; w: number; h: number }>();
    const renderFor = async (rotation: number) => {
      const hit = rendered.get(rotation);
      if (hit) return hit;
      const out = await renderPlacedImage(
        buffer,
        targetWidth,
        targetHeight,
        rotation,
        image.flipX,
        image.flipY,
      );
      const meta = await sharp(out, { limitInputPixels: false }).metadata();
      const entry = { buffer: out, w: meta.width || 0, h: meta.height || 0 };
      rendered.set(rotation, entry);
      return entry;
    };

    for (const placement of placements) {
      const { buffer: processedBuffer, w: bboxWidthPx, h: bboxHeightPx } = await renderFor(
        placement.rotation ?? image.rotation,
      );
      const left = mmToPx(placement.xMm);
      const top = mmToPx(placement.yMm);

      // sharp cannot composite overlays outside the canvas — skip and warn.
      if (
        left < 0 ||
        top < 0 ||
        left + bboxWidthPx > canvasWidthPx ||
        top + bboxHeightPx > canvasHeightPx
      ) {
        console.warn(
          `[export] Skipping copy outside canvas: left=${left}, top=${top}, bbox=${bboxWidthPx}x${bboxHeightPx}, canvas=${canvasWidthPx}x${canvasHeightPx}`,
        );
        continue;
      }

      compositeInputs.push({
        input: processedBuffer,
        left,
        top,
      });
    }
  }

  // Create canvas and composite, with 300 DPI metadata
  const pngBuffer = await sharp({
    create: {
      width: canvasWidthPx,
      height: canvasHeightPx,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
    limitInputPixels: false,
  })
    .composite(compositeInputs)
    .png()
    .withMetadata({ density: EXPORT_DPI })
    .toBuffer();

  // Upload final PNG
  const pngKey = `exports/${data.gangSheetId}/gangsheet.png`;
  await uploadToR2(pngKey, pngBuffer, "image/png");

  // Generate and upload preview
  const previewBuffer = await sharp(pngBuffer, { limitInputPixels: false })
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  const previewKey = `exports/${data.gangSheetId}/preview.webp`;
  await uploadToR2(previewKey, previewBuffer, "image/webp");

  // Update database
  await prisma.gangSheet.update({
    where: { id: data.gangSheetId },
    data: {
      status: "exported",
      exportUrl: pngKey,
      previewUrl: previewKey,
    },
  });

  // Upsert export record (idempotent across webhook redeliveries)
  const existingExport = await prisma.gangSheetExport.findFirst({
    where: { gangSheetId: data.gangSheetId, format: "png" },
  });
  if (existingExport) {
    await prisma.gangSheetExport.update({
      where: { id: existingExport.id },
      data: {
        url: pngKey,
        fileSizeBytes: pngBuffer.length,
        dpi: EXPORT_DPI,
      },
    });
  } else {
    await prisma.gangSheetExport.create({
      data: {
        gangSheetId: data.gangSheetId,
        format: "png",
        url: pngKey,
        fileSizeBytes: pngBuffer.length,
        dpi: EXPORT_DPI,
      },
    });
  }
}

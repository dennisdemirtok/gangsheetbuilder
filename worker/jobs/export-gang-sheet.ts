import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  computeCopyPlacements,
  resolveRasterKey,
} from "../../app/lib/placement";

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

export async function exportGangSheetJob(data: ExportJobData): Promise<void> {
  const gangSheet = await prisma.gangSheet.findUniqueOrThrow({
    where: { id: data.gangSheetId },
    include: { images: true },
  });

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
    const imageKey = resolveRasterKey(image.bgRemovedUrl || image.originalUrl);
    const buffer = await downloadFromR2(imageKey);

    const targetWidth = mmToPx(image.displayWidth);
    const targetHeight = mmToPx(image.displayHeight);

    const processedBuffer = await renderPlacedImage(
      buffer,
      targetWidth,
      targetHeight,
      image.rotation,
      image.flipX,
      image.flipY,
    );

    const meta = await sharp(processedBuffer, {
      limitInputPixels: false,
    }).metadata();
    const bboxWidthPx = meta.width || 0;
    const bboxHeightPx = meta.height || 0;

    // One placement per copy using the shared quantity grid
    const { placements, skipped } = computeCopyPlacements(
      {
        positionX: image.positionX,
        positionY: image.positionY,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
        rotation: image.rotation,
        quantity: image.quantity,
      },
      gangSheet.widthMm,
      gangSheet.heightMm,
    );

    if (skipped > 0) {
      console.warn(
        `[export] Gang sheet ${data.gangSheetId}: skipped ${skipped} copies of "${image.originalFilename}" that exceed the sheet bottom`,
      );
    }

    for (const placement of placements) {
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

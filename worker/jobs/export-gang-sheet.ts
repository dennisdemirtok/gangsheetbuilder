import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

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

    const imageKey = image.bgRemovedUrl || image.originalUrl;
    const buffer = await downloadFromR2(imageKey);

    const targetWidth = mmToPx(image.displayWidth);
    const targetHeight = mmToPx(image.displayHeight);

    let processed = sharp(buffer).resize(targetWidth, targetHeight, {
      fit: "fill",
    });

    if (image.rotation !== 0) {
      processed = processed.rotate(image.rotation);
    }
    if (image.flipX) processed = processed.flop();
    if (image.flipY) processed = processed.flip();

    const processedBuffer = await processed.png().toBuffer();

    compositeInputs.push({
      input: processedBuffer,
      left: mmToPx(image.positionX),
      top: mmToPx(image.positionY),
    });
  }

  // Create canvas and composite
  const pngBuffer = await sharp({
    create: {
      width: canvasWidthPx,
      height: canvasHeightPx,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toBuffer();

  // Upload final PNG
  const pngKey = `exports/${data.gangSheetId}/gangsheet.png`;
  await uploadToR2(pngKey, pngBuffer, "image/png");

  // Generate and upload preview
  const previewBuffer = await sharp(pngBuffer)
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

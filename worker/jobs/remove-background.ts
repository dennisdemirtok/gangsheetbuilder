import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const prisma = new PrismaClient();

interface BgRemovalJobData {
  imageId: string;
  originalUrl: string;
  r2Key: string;
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

export async function removeBackgroundJob(
  data: BgRemovalJobData,
): Promise<void> {
  const apiKey = process.env.REMOVEBG_API_KEY;
  if (!apiKey) {
    throw new Error("REMOVEBG_API_KEY is not configured");
  }

  // Download original image from R2
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: data.r2Key }),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const originalBuffer = Buffer.concat(chunks);

  // Send to remove.bg API
  const formData = new FormData();
  formData.append(
    "image_file",
    new Blob([originalBuffer]),
    "image.png",
  );
  formData.append("size", "auto");

  const bgResponse = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
    },
    body: formData,
  });

  if (!bgResponse.ok) {
    const errorText = await bgResponse.text();
    throw new Error(`remove.bg API error: ${bgResponse.status} ${errorText}`);
  }

  const resultBuffer = Buffer.from(await bgResponse.arrayBuffer());

  // Upload bg-removed image to R2
  const bgRemovedKey = data.r2Key.replace("/original.", "/bg-removed.");
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: bgRemovedKey,
      Body: resultBuffer,
      ContentType: "image/png",
    }),
  );

  // Generate new thumbnail
  const thumbnail = await sharp(resultBuffer)
    .resize({ width: 800, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const thumbnailKey = data.r2Key.replace("/original.", "/thumbnail-bgr.");
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbnailKey + ".webp",
      Body: thumbnail,
      ContentType: "image/webp",
    }),
  );

  // Update database
  await prisma.gangSheetImage.update({
    where: { id: data.imageId },
    data: {
      bgRemoved: true,
      bgRemovedUrl: bgRemovedKey,
      thumbnailUrl: thumbnailKey + ".webp",
    },
  });
}

import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const prisma = new PrismaClient();

interface CleanupJobData {
  type: "images" | "exports";
  olderThanDays: number;
  shopDomain?: string;
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

async function deleteR2Prefix(prefix: string): Promise<void> {
  const client = getS3Client();
  const listResponse = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
  );

  if (listResponse.Contents) {
    await Promise.all(
      listResponse.Contents.map((obj) =>
        client.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }),
        ),
      ),
    );
  }
}

export async function cleanupExpiredJob(
  data: CleanupJobData,
): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - data.olderThanDays);

  if (data.type === "images") {
    // Find and delete old gang sheet images
    const oldImages = await prisma.gangSheetImage.findMany({
      where: {
        createdAt: { lt: cutoffDate },
        ...(data.shopDomain && {
          gangSheet: { shopDomain: data.shopDomain },
        }),
      },
      take: 100,
    });

    for (const image of oldImages) {
      // Delete from R2
      if (image.originalUrl) {
        await deleteR2Prefix(
          image.originalUrl.substring(0, image.originalUrl.lastIndexOf("/")),
        );
      }

      // Delete from database
      await prisma.gangSheetImage.delete({ where: { id: image.id } });
    }

    console.log(
      `[cleanup] Deleted ${oldImages.length} expired images older than ${data.olderThanDays} days`,
    );
  } else if (data.type === "exports") {
    // Find and delete old exports
    const oldExports = await prisma.gangSheetExport.findMany({
      where: {
        createdAt: { lt: cutoffDate },
        ...(data.shopDomain && {
          gangSheet: { shopDomain: data.shopDomain },
        }),
      },
      take: 100,
    });

    for (const exp of oldExports) {
      // Delete from R2
      await deleteR2Prefix(
        exp.url.substring(0, exp.url.lastIndexOf("/")),
      );

      // Delete from database
      await prisma.gangSheetExport.delete({ where: { id: exp.id } });
    }

    console.log(
      `[cleanup] Deleted ${oldExports.length} expired exports older than ${data.olderThanDays} days`,
    );
  }
}

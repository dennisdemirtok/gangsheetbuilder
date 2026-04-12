import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

const BUCKET = () => process.env.R2_BUCKET_NAME || "gangsheet-files";

export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 900, // 15 minutes
): Promise<string> {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn },
  );
}

export async function getPresignedDownloadUrl(
  key: string,
  expiresIn: number = 3600, // 1 hour
): Promise<string> {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: BUCKET(),
      Key: key,
    }),
    { expiresIn },
  );
}

export async function downloadFile(key: string): Promise<Buffer> {
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET(),
      Key: key,
    }),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function deleteFile(key: string): Promise<void> {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET(),
      Key: key,
    }),
  );
}

export async function deletePrefix(prefix: string): Promise<void> {
  const client = getS3Client();
  const listResponse = await client.send(
    new ListObjectsV2Command({
      Bucket: BUCKET(),
      Prefix: prefix,
    }),
  );

  if (listResponse.Contents) {
    await Promise.all(
      listResponse.Contents.map((obj) =>
        client.send(
          new DeleteObjectCommand({
            Bucket: BUCKET(),
            Key: obj.Key!,
          }),
        ),
      ),
    );
  }
}

// Generate a storage key for uploads
export function storageKey(
  sessionId: string,
  imageId: string,
  variant: "original" | "thumbnail" | "bg-removed",
  ext: string,
): string {
  return `uploads/${sessionId}/${imageId}/${variant}.${ext}`;
}

// Generate a storage key for exports
export function exportKey(gangSheetId: string, format: string): string {
  return `exports/${gangSheetId}/gangsheet.${format}`;
}

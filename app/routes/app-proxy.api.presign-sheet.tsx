import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getPresignedUploadUrl } from "../lib/r2.server";
import { v4 as uuidv4 } from "uuid";

/**
 * Get a presigned URL for direct browser-to-R2 upload of a ready-made sheet.
 * This avoids the app proxy body size + timeout limits.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { filename, contentType, fileSize } = body;

    if (!filename || !contentType) {
      return json({ error: "Missing filename or contentType" }, { status: 400 });
    }

    // Max 200 MB
    if (fileSize && fileSize > 200 * 1024 * 1024) {
      return json({ error: "Filen är för stor. Max 200 MB." }, { status: 400 });
    }

    const sheetId = uuidv4();
    const ext = filename.split(".").pop()?.toLowerCase() || "png";
    const r2Key = `ready-sheets/${session.shop}/${sheetId}/original.${ext}`;

    const uploadUrl = await getPresignedUploadUrl(r2Key, contentType, 1800); // 30 min expiry

    return json({
      uploadUrl,
      sheetId,
      r2Key,
    });
  } catch (error) {
    console.error("Presign sheet error:", error);
    return json(
      { error: `Presign misslyckades: ${(error as Error).message}` },
      { status: 500 },
    );
  }
};

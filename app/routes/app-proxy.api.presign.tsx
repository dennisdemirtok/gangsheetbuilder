import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getPresignedUploadUrl, storageKey } from "../lib/r2.server";
import { v4 as uuidv4 } from "uuid";
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "../lib/constants";

/**
 * Generate a presigned URL for direct browser-to-R2 upload.
 * This avoids sending large files through the app server.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { filename, contentType, sessionId } = body;

  if (!filename || !contentType || !sessionId) {
    return json({ error: "Missing required fields" }, { status: 400 });
  }

  // Validate file extension
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext as any)) {
    return json(
      { error: `Filtypen .${ext} stöds inte.` },
      { status: 400 },
    );
  }

  const imageId = uuidv4();
  const key = storageKey(sessionId, imageId, "original", ext);
  const uploadUrl = await getPresignedUploadUrl(key, contentType);

  return json({
    uploadUrl,
    imageId,
    key,
  });
};

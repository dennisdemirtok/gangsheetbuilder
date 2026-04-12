import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { downloadFile } from "../lib/r2.server";

/**
 * Image proxy — streams image data directly from R2.
 * Shopify app proxy doesn't reliably forward 302 redirects,
 * so we download from R2 and serve the bytes.
 *
 * URL: /apps/gangsheet/api/image/<r2-key-path>
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    await authenticate.public.appProxy(request);

    const key = params["*"] || "";
    if (!key) {
      return new Response("Missing key", { status: 400 });
    }

    // Download from R2
    const buffer = await downloadFile(key);

    // Determine content type from extension
    const ext = key.split(".").pop()?.toLowerCase() || "";
    const contentTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      svg: "image/svg+xml",
      gif: "image/gif",
      tiff: "image/tiff",
      tif: "image/tiff",
      pdf: "application/pdf",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "Cache-Control": "public, max-age=3600, immutable",
      },
    });
  } catch (error) {
    console.error("Image proxy error:", error);
    return new Response("Image not found", { status: 404 });
  }
};

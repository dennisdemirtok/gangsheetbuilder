import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { readFileToken } from "../lib/file-links.server";
import { getPresignedAttachmentUrl } from "../lib/r2.server";

/** Download link from a print shop email: a fresh storage link per click. */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const file = readFileToken(params.token || "");
  if (!file) {
    return new Response(
      "This download link is invalid or has expired. / Link do pobrania jest nieprawidłowy lub wygasł.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  return redirect(await getPresignedAttachmentUrl(file.k, file.n, 300));
};

/**
 * Save a file from inside the embedded admin.
 *
 * The app lives in Shopify's iframe. Links opened in a new tab from there
 * landed the print shop on an empty page, so files are saved in place: the
 * server hands back an attachment URL (or the bytes) and we click a
 * throwaway link to it.
 */

export function saveUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

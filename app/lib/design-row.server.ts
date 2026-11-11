import type { GangSheetImage } from "@prisma/client";

/**
 * What a copy of a design row shares with it: the file, not its place.
 * Both rows then print from the one file in storage; nothing is copied there.
 */
export function designFile(row: GangSheetImage) {
  return {
    originalUrl: row.originalUrl,
    thumbnailUrl: row.thumbnailUrl,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    dpiX: row.dpiX,
    dpiY: row.dpiY,
    bgRemoved: row.bgRemoved,
    bgRemovedUrl: row.bgRemovedUrl,
  };
}

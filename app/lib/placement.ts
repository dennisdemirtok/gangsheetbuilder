/**
 * Shared placement/grid math for gang sheet exports.
 *
 * IMPORTANT: This module is imported by BOTH the Remix app (app/lib, app/routes)
 * and the standalone worker (worker/jobs). It must stay free of any
 * server-only / remix-specific / sharp imports so the logic can never drift
 * between the export paths.
 *
 * Placement contract (shared with the editor):
 * - positionX/positionY (mm) = TOP-LEFT of the axis-aligned bounding box of
 *   the placed (possibly rotated) image on the sheet.
 * - displayWidth/displayHeight (mm) = UNROTATED image dimensions.
 * - rotation = degrees clockwise, any float.
 * - flipX/flipY are applied in object space BEFORE rotation (Fabric.js
 *   semantics; sharp's flip()/flop() also run before rotate() in a pipeline).
 */

// Default gap between grid copies in mm (mirrors DEFAULT_MARGIN_MM).
export const DEFAULT_PLACEMENT_GAP_MM = 5;

export interface PlacementImage {
  positionX: number; // mm, top-left of rotated bounding box
  positionY: number; // mm
  displayWidth: number; // mm, unrotated
  displayHeight: number; // mm, unrotated
  rotation: number; // degrees clockwise
  quantity: number;
  marginMm?: number | null; // per-image gap; defaults to 5mm
}

export interface CopyPlacement {
  xMm: number; // top-left of the bounding box for this copy
  yMm: number;
}

export interface PlacementResult {
  bboxWidthMm: number;
  bboxHeightMm: number;
  placements: CopyPlacement[];
  skipped: number; // copies dropped because they exceed the sheet bottom
}

/**
 * Axis-aligned bounding box of a w×h rectangle rotated by `rotationDeg`.
 */
export function rotatedBoundingBox(
  widthMm: number,
  heightMm: number,
  rotationDeg: number,
): { widthMm: number; heightMm: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    widthMm: widthMm * cos + heightMm * sin,
    heightMm: widthMm * sin + heightMm * cos,
  };
}

/**
 * Compute the position of every rendered copy of an image.
 *
 * Quantity grid (byte-identical to the editor):
 *   gap  = image.marginMm ?? 5
 *   cols = max(1, floor((sheetWidthMm - gap) / (bboxW + gap)))
 *   copy i (0-based): x = gap + (i % cols) * (bboxW + gap)
 *                     y = gap + floor(i / cols) * (bboxH + gap)
 *
 * EXCEPTION: quantity === 1 uses the stored positionX/positionY.
 * Grid copies whose bounding box exceeds the sheet bottom are skipped
 * (counted in `skipped`); the caller should log a warning.
 */
export function computeCopyPlacements(
  image: PlacementImage,
  sheetWidthMm: number,
  sheetHeightMm: number,
): PlacementResult {
  const gap = image.marginMm ?? DEFAULT_PLACEMENT_GAP_MM;
  const bbox = rotatedBoundingBox(
    image.displayWidth,
    image.displayHeight,
    image.rotation,
  );
  const quantity = Math.max(1, Math.floor(image.quantity || 1));

  if (quantity === 1) {
    return {
      bboxWidthMm: bbox.widthMm,
      bboxHeightMm: bbox.heightMm,
      placements: [{ xMm: image.positionX, yMm: image.positionY }],
      skipped: 0,
    };
  }

  const cols = Math.max(
    1,
    Math.floor((sheetWidthMm - gap) / (bbox.widthMm + gap)),
  );

  const placements: CopyPlacement[] = [];
  let skipped = 0;

  for (let i = 0; i < quantity; i++) {
    const xMm = gap + (i % cols) * (bbox.widthMm + gap);
    const yMm = gap + Math.floor(i / cols) * (bbox.heightMm + gap);

    if (yMm + bbox.heightMm > sheetHeightMm) {
      skipped++;
      continue;
    }
    placements.push({ xMm, yMm });
  }

  return {
    bboxWidthMm: bbox.widthMm,
    bboxHeightMm: bbox.heightMm,
    placements,
    skipped,
  };
}

/**
 * Map a stored R2 key for a vector original (EPS/AI/PS) to the
 * Ghostscript-rasterized PNG that the upload route stores alongside it.
 * Raster keys are returned unchanged.
 */
export function resolveRasterKey(key: string): string {
  return key.replace(/\/original\.(eps|ai|ps)$/i, "/converted.png");
}

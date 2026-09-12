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

/**
 * Safety margin to the film edge in mm. The outer centimetre of DTF film
 * is unreliable to print and handle, so nothing is nested into it.
 * Mirrored by EDGE_MARGIN_MM in editor/src/utils/layout.ts — change both.
 */
export const EDGE_MARGIN_MM = 10;

export interface PlacementImage {
  positionX: number; // mm, top-left of rotated bounding box
  positionY: number; // mm
  displayWidth: number; // mm, unrotated
  displayHeight: number; // mm, unrotated
  rotation: number; // degrees clockwise
  quantity: number;
  marginMm?: number | null; // per-image gap; defaults to 5mm
  /**
   * Explicit top-left position of every copy, as arranged in the editor.
   * When present this wins over the quantity grid — the grid packs from the
   * top-left ignoring other designs, so two designs with quantity > 1 used
   * to be printed on top of each other.
   */
  placements?: CopyPlacement[] | null;
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
 * `image.placements` (explicit per-copy positions) takes precedence over
 * the grid entirely; the grid is the fallback for pre-placement records.
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

  // Preferred path: print exactly where the editor put each copy.
  if (image.placements && image.placements.length > 0) {
    const placements: CopyPlacement[] = [];
    let skipped = 0;
    for (const copy of image.placements) {
      if (copy.yMm + bbox.heightMm > sheetHeightMm) {
        skipped++;
        continue;
      }
      placements.push({ xMm: copy.xMm, yMm: copy.yMm });
    }
    return {
      bboxWidthMm: bbox.widthMm,
      bboxHeightMm: bbox.heightMm,
      placements,
      skipped,
    };
  }

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
 * Read the stored per-copy placements off a GangSheetImage row.
 * The column is free-form JSON, so anything malformed falls back to the
 * quantity grid rather than throwing mid-export.
 */
export function parseStoredPlacements(value: unknown): CopyPlacement[] | null {
  if (!Array.isArray(value)) return null;
  const out: CopyPlacement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { xMm, yMm } = entry as { xMm?: unknown; yMm?: unknown };
    if (typeof xMm !== "number" || typeof yMm !== "number") continue;
    if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) continue;
    out.push({ xMm, yMm });
  }
  return out.length > 0 ? out : null;
}

/**
 * Map a stored R2 key for a vector original (EPS/AI/PS) to the
 * Ghostscript-rasterized PNG that the upload route stores alongside it.
 * Raster keys are returned unchanged.
 */
export function resolveRasterKey(key: string): string {
  return key.replace(/\/original\.(eps|ai|ps)$/i, "/converted.png");
}

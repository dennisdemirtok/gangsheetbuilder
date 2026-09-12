/**
 * Shared layout rules for the gang sheet: margins, collision, packing.
 *
 * One place decides how far designs sit from each other and from the film
 * edge. Auto-arrange, autofill, upload placement and the export all read
 * these constants so a customer never sees one gap on screen and another
 * one in print.
 */

/**
 * Safety margin to the film edge (mm). Not customer-configurable — the
 * outer centimetre of DTF film is unreliable to print and handle.
 */
export const EDGE_MARGIN_MM = 10;

/** Gap between neighbouring designs (mm). */
export const GAP_PRESETS = {
  tight: 3,
  normal: 5,
  roomy: 10,
} as const;

export type GapPreset = keyof typeof GAP_PRESETS;

export const GAP_PRESET_LABELS: Record<GapPreset, string> = {
  tight: "Tight",
  normal: "Normal",
  roomy: "Rymlig",
};

/** Mirrors DEFAULT_PLACEMENT_GAP_MM in app/lib/placement.ts. */
export const DEFAULT_GAP_MM: number = GAP_PRESETS.normal;

export function gapPresetFromMm(mm: number): GapPreset | null {
  const found = (Object.keys(GAP_PRESETS) as GapPreset[]).find(
    (k) => GAP_PRESETS[k] === mm,
  );
  return found ?? null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetDims {
  widthMm: number;
  heightMm: number;
}

/** Axis-aligned bounding box (mm) of a w×h rect rotated `angleDeg` clockwise. */
export function rotatedBboxMm(
  widthMm: number,
  heightMm: number,
  angleDeg: number,
): { bboxW: number; bboxH: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    bboxW: widthMm * cos + heightMm * sin,
    bboxH: widthMm * sin + heightMm * cos,
  };
}

export interface BboxSource {
  positionX: number;
  positionY: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
}

/** The bounding box an image occupies on the sheet, per the placement contract. */
export function imageBbox(img: BboxSource): Rect {
  const { bboxW, bboxH } = rotatedBboxMm(
    img.displayWidth,
    img.displayHeight,
    img.rotation,
  );
  return { x: img.positionX, y: img.positionY, w: bboxW, h: bboxH };
}

/**
 * Do two rects overlap? `tolerance` lets touching edges pass — floating
 * point drift from rotation must not be reported as a collision.
 */
export function rectsOverlap(a: Rect, b: Rect, tolerance = 0.5): boolean {
  return (
    a.x + a.w - tolerance > b.x &&
    b.x + b.w - tolerance > a.x &&
    a.y + a.h - tolerance > b.y &&
    b.y + b.h - tolerance > a.y
  );
}

/** Ids of every image that overlaps at least one other image. */
export function findOverlappingIds<T extends BboxSource & { id: string }>(
  images: T[],
): Set<string> {
  const boxes = images.map((img) => ({ id: img.id, rect: imageBbox(img) }));
  const hits = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i]!.rect, boxes[j]!.rect)) {
        hits.add(boxes[i]!.id);
        hits.add(boxes[j]!.id);
      }
    }
  }
  return hits;
}

/** Does the image stick out past the printable area? */
export function isOutsidePrintable(img: BboxSource, sheet: SheetDims): boolean {
  const r = imageBbox(img);
  const t = 0.5;
  return (
    r.x < EDGE_MARGIN_MM - t ||
    r.y < EDGE_MARGIN_MM - t ||
    r.x + r.w > sheet.widthMm - EDGE_MARGIN_MM + t ||
    r.y + r.h > sheet.heightMm - EDGE_MARGIN_MM + t
  );
}

/** The rectangle designs may actually occupy. */
export function printableArea(sheet: SheetDims): Rect {
  return {
    x: EDGE_MARGIN_MM,
    y: EDGE_MARGIN_MM,
    w: Math.max(0, sheet.widthMm - EDGE_MARGIN_MM * 2),
    h: Math.max(0, sheet.heightMm - EDGE_MARGIN_MM * 2),
  };
}

/** How many w×h copies fit in the printable area at this gap. */
export function capacity(
  w: number,
  h: number,
  sheet: SheetDims,
  gap: number,
): { cols: number; rows: number; total: number } {
  const area = printableArea(sheet);
  if (w <= 0 || h <= 0) return { cols: 0, rows: 0, total: 0 };
  const cols = Math.floor((area.w + gap) / (w + gap));
  const rows = Math.floor((area.h + gap) / (h + gap));
  const safeCols = Math.max(0, cols);
  const safeRows = Math.max(0, rows);
  return { cols: safeCols, rows: safeRows, total: safeCols * safeRows };
}

/**
 * Grid cells for the printable area, row-major, at the given item size.
 * Used to lay a group of identical copies out around whatever is already
 * on the sheet.
 */
export function gridCells(
  w: number,
  h: number,
  sheet: SheetDims,
  gap: number,
): Rect[] {
  const area = printableArea(sheet);
  const { cols, rows } = capacity(w, h, sheet, gap);
  const cells: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        x: area.x + col * (w + gap),
        y: area.y + row * (h + gap),
        w,
        h,
      });
    }
  }
  return cells;
}

/** A cell is free when it clears every blocker by at least `gap`. */
function cellIsFree(cell: Rect, blockers: Rect[], gap: number): boolean {
  const padded: Rect = {
    x: cell.x - gap,
    y: cell.y - gap,
    w: cell.w + gap * 2,
    h: cell.h + gap * 2,
  };
  return !blockers.some((b) => rectsOverlap(padded, b));
}

/**
 * Place `count` copies of a w×h design on the sheet without touching
 * anything in `blockers`. Returns as many positions as actually fit.
 */
export function placeGroup(
  count: number,
  w: number,
  h: number,
  sheet: SheetDims,
  gap: number,
  blockers: Rect[],
): { x: number; y: number }[] {
  if (count <= 0 || w <= 0 || h <= 0) return [];
  const cells = gridCells(w, h, sheet, gap);
  const out: { x: number; y: number }[] = [];
  for (const cell of cells) {
    if (out.length >= count) break;
    if (!cellIsFree(cell, blockers, gap)) continue;
    out.push({ x: cell.x, y: cell.y });
  }
  return out;
}

/** How many more copies of this design fit in the space still free. */
export function freeCapacityFor(
  w: number,
  h: number,
  sheet: SheetDims,
  gap: number,
  blockers: Rect[],
): number {
  return gridCells(w, h, sheet, gap).filter((c) => cellIsFree(c, blockers, gap))
    .length;
}

/**
 * First free spot for a single w×h design, scanning row-major.
 * Returns null when nothing fits — the caller should grow the sheet.
 */
export function findFreeSpot(
  w: number,
  h: number,
  sheet: SheetDims,
  gap: number,
  blockers: Rect[],
): { x: number; y: number } | null {
  const area = printableArea(sheet);
  if (w > area.w || h > area.h) return null;
  const step = Math.max(5, Math.min(w, h) / 4);
  for (let y = area.y; y + h <= area.y + area.h + 0.01; y += step) {
    for (let x = area.x; x + w <= area.x + area.w + 0.01; x += step) {
      if (cellIsFree({ x, y, w, h }, blockers, gap)) return { x, y };
    }
  }
  return null;
}

export interface PackItem {
  id: string;
  w: number;
  h: number;
}

export interface PackResult {
  positions: Map<string, { x: number; y: number }>;
  overflow: string[];
  usedHeightMm: number;
}

/**
 * Shelf-pack every item into the printable area, tallest first.
 * Deterministic and always collision-free — used for "arrange everything"
 * and for working out how much film an order needs.
 */
export function packAll(
  items: PackItem[],
  sheet: SheetDims,
  gap: number,
): PackResult {
  const area = printableArea(sheet);
  const positions = new Map<string, { x: number; y: number }>();
  const overflow: string[] = [];

  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);

  let shelfY = area.y;
  let shelfHeight = 0;
  let cursorX = area.x;
  let usedBottom = area.y;

  for (const item of sorted) {
    if (item.w > area.w || item.h > area.h) {
      overflow.push(item.id);
      continue;
    }
    // Start a new shelf when this item no longer fits on the current one.
    if (cursorX + item.w > area.x + area.w + 0.01) {
      shelfY += shelfHeight + gap;
      shelfHeight = 0;
      cursorX = area.x;
    }
    if (shelfY + item.h > area.y + area.h + 0.01) {
      overflow.push(item.id);
      continue;
    }
    positions.set(item.id, { x: cursorX, y: shelfY });
    cursorX += item.w + gap;
    shelfHeight = Math.max(shelfHeight, item.h);
    usedBottom = Math.max(usedBottom, shelfY + item.h);
  }

  return {
    positions,
    overflow,
    usedHeightMm: Math.max(0, usedBottom - area.y),
  };
}

/**
 * Height of film (mm) these items need, ignoring the sheet's own height.
 * Drives the quantity-first flow: designs and counts in, metres out.
 */
export function requiredHeightMm(
  items: PackItem[],
  sheetWidthMm: number,
  gap: number,
): number {
  // Pack against a sheet tall enough that nothing can overflow, then read
  // back how far down the content actually reached.
  const tallEnough =
    items.reduce((sum, i) => sum + i.h + gap, 0) + EDGE_MARGIN_MM * 2;
  const { usedHeightMm } = packAll(
    items,
    { widthMm: sheetWidthMm, heightMm: tallEnough },
    gap,
  );
  return usedHeightMm + EDGE_MARGIN_MM * 2;
}

/** Fraction (0–1) of the printable area covered by these boxes. */
export function utilization(boxes: Rect[], sheet: SheetDims): number {
  const area = printableArea(sheet);
  const total = area.w * area.h;
  if (total <= 0) return 0;
  const used = boxes.reduce((sum, b) => sum + b.w * b.h, 0);
  return Math.min(1, used / total);
}

/** Lowest point any design reaches, measured from the top of the sheet (mm). */
export function contentBottomMm(boxes: Rect[]): number {
  return boxes.reduce((max, b) => Math.max(max, b.y + b.h), 0);
}

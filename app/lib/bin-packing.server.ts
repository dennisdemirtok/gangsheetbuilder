/**
 * MAXRECTS Bin Packing Algorithm
 * Places rectangles optimally on a 2D sheet using Best Short Side Fit.
 */
import { EDGE_MARGIN_MM } from "./placement";

export interface PackingInput {
  id: string;
  width: number; // in mm
  height: number; // in mm
  quantity: number;
}

export interface PackingResult {
  id: string;
  x: number; // position in mm
  y: number;
  width: number; // placed size in mm
  height: number;
  rotated: boolean;
}

export interface PackingOutput {
  placements: PackingResult[];
  usedHeight: number; // actual height used in mm
  utilization: number; // percentage of area used
  overflow: PackingInput[]; // items that didn't fit
}

interface FreeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Run the MAXRECTS bin packing algorithm.
 * Tries multiple sorting strategies and returns the best result.
 */
export function packImages(
  items: PackingInput[],
  sheetWidthMm: number,
  sheetHeightMm: number,
  gapMm: number = 5,
  edgeMm: number = EDGE_MARGIN_MM,
): PackingOutput {
  // Nest inside the printable area, then shift results back onto sheet
  // coordinates — designs must never touch the film edge.
  const edge = Math.max(0, edgeMm);
  const innerWidth = Math.max(0, sheetWidthMm - edge * 2);
  const innerHeight = Math.max(0, sheetHeightMm - edge * 2);

  // Expand items by quantity
  const expanded: { id: string; width: number; height: number }[] = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i++) {
      expanded.push({
        id: item.id,
        width: item.width + gapMm,
        height: item.height + gapMm,
      });
    }
  }

  // Try different sorting strategies
  const strategies = [
    // Sort by area descending
    [...expanded].sort((a, b) => b.width * b.height - a.width * a.height),
    // Sort by longest side descending
    [...expanded].sort(
      (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height),
    ),
    // Sort by perimeter descending
    [...expanded].sort(
      (a, b) => b.width + b.height - (a.width + a.height),
    ),
    // Sort by shortest side descending
    [...expanded].sort(
      (a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height),
    ),
  ];

  let bestResult: PackingOutput | null = null;
  const left = (r: PackingOutput) => r.overflow.reduce((sum, o) => sum + o.quantity, 0);

  // Fewest copies left out first, then the densest. Density alone once
  // preferred a run that placed fewer copies tighter.
  for (const sorted of strategies) {
    for (const mode of TURN_MODES) {
      const result = runMaxRects(sorted, innerWidth, innerHeight, gapMm, mode);
      if (
        !bestResult ||
        left(result) < left(bestResult) ||
        (left(result) === left(bestResult) && result.utilization > bestResult.utilization)
      ) {
        bestResult = result;
      }
    }
  }

  const best = bestResult!;
  return {
    ...best,
    placements: best.placements.map((p) => ({
      ...p,
      x: p.x + edge,
      y: p.y + edge,
    })),
    usedHeight: best.usedHeight + edge * 2,
  };
}

/**
 * How designs may turn in one run. Best Short Side Fit turns a portrait
 * design whenever its leftover is smaller, even when two upright fit side
 * by side: #1154's 27 × 33 cm motif went into one turned column, 37 on
 * 10 m, where 40 upright fit on 6.6 m. So each order is also tried with
 * every design as it comes and with every design turned.
 */
type TurnMode = "free" | "asIs" | "turned";
const TURN_MODES: TurnMode[] = ["free", "asIs", "turned"];

function runMaxRects(
  items: { id: string; width: number; height: number }[],
  sheetWidth: number,
  sheetHeight: number,
  gapMm: number,
  mode: TurnMode,
): PackingOutput {
  const freeRects: FreeRect[] = [
    { x: 0, y: 0, width: sheetWidth, height: sheetHeight },
  ];
  const placements: PackingResult[] = [];
  const overflow: PackingInput[] = [];

  for (const item of items) {
    const turn = mode === "turned" && Math.abs(item.width - item.height) > 0.01;
    const placement = findBestPosition(
      freeRects,
      turn ? item.height : item.width,
      turn ? item.width : item.height,
      mode === "free",
    );

    if (!placement) {
      // Item doesn't fit — add to overflow
      const existing = overflow.find((o) => o.id === item.id);
      if (existing) {
        existing.quantity++;
      } else {
        overflow.push({
          id: item.id,
          width: item.width - gapMm,
          height: item.height - gapMm,
          quantity: 1,
        });
      }
      continue;
    }

    const { x, y } = placement;
    const rotated = placement.rotated !== turn;
    const placedW = rotated ? item.height : item.width;
    const placedH = rotated ? item.width : item.height;

    // Store placement (subtract gap from display dimensions)
    placements.push({
      id: item.id,
      x,
      y,
      width: placedW - gapMm,
      height: placedH - gapMm,
      rotated,
    });

    // Split free rectangles
    splitFreeRects(freeRects, { x, y, width: placedW, height: placedH });
    pruneFreeRects(freeRects);
  }

  // Calculate used height and utilization
  let usedHeight = 0;
  let totalArea = 0;
  for (const p of placements) {
    usedHeight = Math.max(usedHeight, p.y + p.height);
    totalArea += p.width * p.height;
  }
  const utilization =
    usedHeight > 0 ? totalArea / (sheetWidth * usedHeight) : 0;

  return { placements, usedHeight, utilization, overflow };
}

interface PlacementCandidate {
  x: number;
  y: number;
  rotated: boolean;
}

/**
 * Best Short Side Fit: find the free rect where the shorter leftover side
 * after placing the item is minimized.
 */
function findBestPosition(
  freeRects: FreeRect[],
  width: number,
  height: number,
  mayRotate: boolean,
): PlacementCandidate | null {
  let bestScore = Infinity;
  let best: PlacementCandidate | null = null;

  for (const rect of freeRects) {
    // Try original orientation
    if (width <= rect.width && height <= rect.height) {
      const leftoverX = rect.width - width;
      const leftoverY = rect.height - height;
      const score = Math.min(leftoverX, leftoverY);
      if (score < bestScore) {
        bestScore = score;
        best = { x: rect.x, y: rect.y, rotated: false };
      }
    }

    // Try rotated orientation
    if (mayRotate && height <= rect.width && width <= rect.height) {
      const leftoverX = rect.width - height;
      const leftoverY = rect.height - width;
      const score = Math.min(leftoverX, leftoverY);
      if (score < bestScore) {
        bestScore = score;
        best = { x: rect.x, y: rect.y, rotated: true };
      }
    }
  }

  return best;
}

/**
 * After placing a rect, split any overlapping free rects.
 */
function splitFreeRects(
  freeRects: FreeRect[],
  placed: FreeRect,
): void {
  const len = freeRects.length;
  for (let i = len - 1; i >= 0; i--) {
    const free = freeRects[i];
    if (!intersects(free, placed)) continue;

    // Remove the overlapping free rect
    freeRects.splice(i, 1);

    // Generate new free rects from the non-overlapping portions
    // Left portion
    if (placed.x > free.x) {
      freeRects.push({
        x: free.x,
        y: free.y,
        width: placed.x - free.x,
        height: free.height,
      });
    }
    // Right portion
    if (placed.x + placed.width < free.x + free.width) {
      freeRects.push({
        x: placed.x + placed.width,
        y: free.y,
        width: free.x + free.width - (placed.x + placed.width),
        height: free.height,
      });
    }
    // Top portion
    if (placed.y > free.y) {
      freeRects.push({
        x: free.x,
        y: free.y,
        width: free.width,
        height: placed.y - free.y,
      });
    }
    // Bottom portion
    if (placed.y + placed.height < free.y + free.height) {
      freeRects.push({
        x: free.x,
        y: placed.y + placed.height,
        width: free.width,
        height: free.y + free.height - (placed.y + placed.height),
      });
    }
  }
}

/**
 * Remove free rects that are fully contained by another free rect.
 */
function pruneFreeRects(freeRects: FreeRect[]): void {
  for (let i = freeRects.length - 1; i >= 0; i--) {
    for (let j = freeRects.length - 1; j >= 0; j--) {
      if (i === j) continue;
      if (contains(freeRects[j], freeRects[i])) {
        freeRects.splice(i, 1);
        break;
      }
    }
  }
}

function intersects(a: FreeRect, b: FreeRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Suggest the next larger sheet size if the current one overflows.
 */
export function suggestLargerSheet(
  currentSizeKey: string,
): string | null {
  const sizes = ["58x100", "58x200", "58x300", "58x400", "58x500"];
  const idx = sizes.indexOf(currentSizeKey);
  if (idx < 0 || idx >= sizes.length - 1) return null;
  return sizes[idx + 1];
}

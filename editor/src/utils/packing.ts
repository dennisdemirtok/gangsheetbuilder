/**
 * Nesting designs on the film so the sheet is as short as it can be.
 *
 * The builder used to estimate film with a shelf packer that never turned
 * a design, while the server arranged with one that did. Two 28 cm logos
 * don't fit side by side on 56 cm of printable film, but one upright and
 * one turned do — so the guide chose 5 m for what the arrange then laid
 * out on 2.6 m, and the customer was charged for 5. One algorithm now does
 * both, in the browser: MAXRECTS with the bottom-left rule (every design
 * goes as high up the film as it can), turning a design 90° when that
 * saves film, trying a few orders and keeping the shortest result.
 *
 * Designs already on the sheet can be passed as obstacles, so new ones are
 * nested into the free space around them without moving anything.
 */

import { EDGE_MARGIN_MM, printableArea, type Rect, type SheetDims } from "./layout";

export interface PackInput {
  id: string;
  /** Footprint on the sheet as the design is turned now (mm). */
  w: number;
  h: number;
  /** May be turned 90° to save film. */
  rotatable?: boolean;
}

export interface Placement {
  /** Top-left on the sheet (mm). */
  x: number;
  y: number;
  /** Footprint as placed (mm) — w and h swap when `rotated`. */
  w: number;
  h: number;
  /** Turned 90° from how it came in. */
  rotated: boolean;
}

export interface PackOutcome {
  placements: Map<string, Placement>;
  overflow: string[];
  /** Lowest point any design reaches, from the top of the sheet (mm). */
  bottomMm: number;
}

interface Free {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Orders to try; the shortest result wins. Ties keep the earlier order. */
const ORDERS: ((a: PackInput, b: PackInput) => number)[] = [
  (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
  (a, b) => b.w * b.h - a.w * a.h,
  (a, b) => b.h - a.h || b.w - a.w,
  (a, b) => b.w - a.w || b.h - a.h,
];

/** Above this many copies, two orders are plenty — and stay fast. */
const MANY = 600;

/**
 * Nest `items` in the printable area of `sheet`. Gaps between designs are
 * `gap`; the film edge keeps EDGE_MARGIN_MM. Obstacles (sheet coordinates,
 * already including nothing extra) are kept clear by `gap`.
 */
export function packSheet(
  items: PackInput[],
  sheet: SheetDims,
  gap: number,
  obstacles: Rect[] = [],
): PackOutcome {
  const orders = items.length > MANY ? ORDERS.slice(0, 2) : ORDERS;
  let best: PackOutcome | null = null;
  for (const order of orders) {
    const result = runOnce([...items].sort(order), sheet, gap, obstacles);
    if (
      !best ||
      result.overflow.length < best.overflow.length ||
      (result.overflow.length === best.overflow.length && result.bottomMm < best.bottomMm - 0.01)
    ) {
      best = result;
    }
  }
  return best ?? { placements: new Map(), overflow: [], bottomMm: 0 };
}

/**
 * Film (mm, including both edge margins) these designs need at
 * `sheetWidthMm`, ignoring any sheet length.
 */
export function neededHeightMm(items: PackInput[], sheetWidthMm: number, gap: number): number {
  if (items.length === 0) return 0;
  const tall = items.reduce((sum, i) => sum + Math.max(i.w, i.h) + gap, 0) + EDGE_MARGIN_MM * 2;
  const { bottomMm, overflow } = packSheet(items, { widthMm: sheetWidthMm, heightMm: tall }, gap);
  // Something wider than the film in both orientations never fits.
  if (overflow.length > 0) return Infinity;
  return bottomMm + EDGE_MARGIN_MM;
}

function runOnce(items: PackInput[], sheet: SheetDims, gap: number, obstacles: Rect[]): PackOutcome {
  const area = printableArea(sheet);
  // Every design reserves `gap` to its right and below; the bin is that
  // much bigger, so the last column and row need no trailing gap.
  const binW = area.w + gap;
  const binH = area.h + gap;
  const free: Free[] = [{ x: 0, y: 0, w: binW, h: binH }];

  for (const o of obstacles) {
    // In bin coordinates, grown by the gap on every side.
    split(free, {
      x: o.x - area.x - gap,
      y: o.y - area.y - gap,
      w: o.w + gap * 2,
      h: o.h + gap * 2,
    });
    prune(free);
  }

  const placements = new Map<string, Placement>();
  const overflow: string[] = [];
  let bottom = obstacles.reduce((max, o) => Math.max(max, o.y + o.h), 0);

  for (const item of items) {
    const w = item.w + gap;
    const h = item.h + gap;
    const spot = bestSpot(free, w, h, item.rotatable !== false && Math.abs(item.w - item.h) > 0.01);
    if (!spot) {
      overflow.push(item.id);
      continue;
    }
    const pw = spot.rotated ? h : w;
    const ph = spot.rotated ? w : h;
    split(free, { x: spot.x, y: spot.y, w: pw, h: ph });
    prune(free);
    const placed: Placement = {
      x: area.x + spot.x,
      y: area.y + spot.y,
      w: pw - gap,
      h: ph - gap,
      rotated: spot.rotated,
    };
    placements.set(item.id, placed);
    bottom = Math.max(bottom, placed.y + placed.h);
  }

  return { placements, overflow, bottomMm: bottom };
}

/** Bottom-left: the spot whose bottom edge is highest up, then leftmost. */
function bestSpot(free: Free[], w: number, h: number, mayRotate: boolean) {
  let best: { x: number; y: number; rotated: boolean } | null = null;
  let bestBottom = Infinity;
  let bestX = Infinity;
  const consider = (r: Free, cw: number, ch: number, rotated: boolean) => {
    if (cw > r.w + 1e-6 || ch > r.h + 1e-6) return;
    const bottom = r.y + ch;
    if (bottom < bestBottom - 1e-6 || (Math.abs(bottom - bestBottom) <= 1e-6 && r.x < bestX)) {
      bestBottom = bottom;
      bestX = r.x;
      best = { x: r.x, y: r.y, rotated };
    }
  };
  for (const r of free) {
    consider(r, w, h, false);
    if (mayRotate) consider(r, h, w, true);
  }
  return best as { x: number; y: number; rotated: boolean } | null;
}

function overlaps(a: Free, b: Free): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Cut `used` out of every free rectangle it touches (MAXRECTS split). */
function split(free: Free[], used: Free): void {
  for (let i = free.length - 1; i >= 0; i--) {
    const f = free[i]!;
    if (!overlaps(f, used)) continue;
    free.splice(i, 1);
    if (used.x > f.x) free.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
    if (used.x + used.w < f.x + f.w) {
      free.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - (used.x + used.w), h: f.h });
    }
    if (used.y > f.y) free.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
    if (used.y + used.h < f.y + f.h) {
      free.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - (used.y + used.h) });
    }
  }
}

/** Drop free rectangles that sit entirely inside another one. */
function prune(free: Free[]): void {
  for (let i = free.length - 1; i >= 0; i--) {
    const a = free[i]!;
    for (let j = free.length - 1; j >= 0; j--) {
      if (i === j) continue;
      const b = free[j]!;
      if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
        free.splice(i, 1);
        break;
      }
    }
  }
}

import type { SheetSize } from "../store/editorStore";

/**
 * Film is sold by the decimetre from 1 m up. Sheets used to come in whole
 * metres only, so designs needing 1,3 m paid for 2 m of film. The length
 * now follows the designs in 10 cm steps; whole metres are still billed
 * with their own variants, other lengths with the per-decimetre one — at
 * the same price per metre.
 */

export const SHEET_WIDTH_MM = 580;
/** Shortest sheet sold. */
export const MIN_SHEET_MM = 1000;
/** Longest single sheet; more goes on a second sheet. */
export const MAX_SHEET_MM = 10000;
/** Lengths come in decimetres. */
export const SHEET_STEP_MM = 100;

/** "1,5 meter (58×150 cm)". */
export function sheetLabel(heightMm: number): string {
  const m = (heightMm / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 });
  return `${m} meter (58×${Math.round(heightMm / 10)} cm)`;
}

/** The sheet for a length, rounded up to a decimetre within the range sold. */
export function sheetForHeight(heightMm: number): SheetSize & { meters: number } {
  const steps = Math.ceil(heightMm / SHEET_STEP_MM - 1e-6);
  const h = Math.min(MAX_SHEET_MM, Math.max(MIN_SHEET_MM, steps * SHEET_STEP_MM));
  return {
    key: `58x${Math.round(h / 10)}`,
    widthMm: SHEET_WIDTH_MM,
    heightMm: h,
    label: sheetLabel(h),
    meters: h / 1000,
  };
}

/** Quick picks: the whole metres. Any decimetre length is valid too. */
export const SHEET_SIZES: (SheetSize & { meters: number })[] = [1, 2, 3, 4, 5].map((m) =>
  sheetForHeight(m * 1000),
);

/** The shortest sheet at least `heightMm` long (within the range sold). */
export function smallestSheetFor(heightMm: number): SheetSize & { meters: number } {
  return sheetForHeight(heightMm);
}

/** One decimetre longer, or null at the longest sheet. */
export function nextSheetUp(current: SheetSize): (SheetSize & { meters: number }) | null {
  if (current.heightMm >= MAX_SHEET_MM) return null;
  return sheetForHeight(current.heightMm + SHEET_STEP_MM);
}

/** "58x150" → the 1,5 m sheet. */
export function sheetByKey(key: string): (SheetSize & { meters: number }) | undefined {
  const m = /^58x(\d+)$/.exec(key);
  return m ? sheetForHeight(Number(m[1]) * 10) : undefined;
}

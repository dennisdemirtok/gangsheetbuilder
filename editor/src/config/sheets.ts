import type { SheetSize } from "../store/editorStore";

/**
 * The film lengths customers can order. Width is fixed by the printer (58 cm).
 * Keys must match the pricing table returned by /api/pricing.
 */
export const SHEET_SIZES: (SheetSize & { meters: number })[] = [
  { key: "58x100", widthMm: 580, heightMm: 1000, label: "1 meter (58×100 cm)", meters: 1 },
  { key: "58x200", widthMm: 580, heightMm: 2000, label: "2 meter (58×200 cm)", meters: 2 },
  { key: "58x300", widthMm: 580, heightMm: 3000, label: "3 meter (58×300 cm)", meters: 3 },
  { key: "58x400", widthMm: 580, heightMm: 4000, label: "4 meter (58×400 cm)", meters: 4 },
  { key: "58x500", widthMm: 580, heightMm: 5000, label: "5 meter (58×500 cm)", meters: 5 },
];

export const SHEET_WIDTH_MM = 580;

/** The smallest sheet at least `heightMm` tall, or the largest one we sell. */
export function smallestSheetFor(heightMm: number): SheetSize & { meters: number } {
  return (
    SHEET_SIZES.find((s) => s.heightMm >= heightMm) ??
    SHEET_SIZES[SHEET_SIZES.length - 1]!
  );
}

/** The next size up, or null when already at the largest. */
export function nextSheetUp(
  current: SheetSize,
): (SheetSize & { meters: number }) | null {
  const idx = SHEET_SIZES.findIndex((s) => s.key === current.key);
  if (idx === -1 || idx === SHEET_SIZES.length - 1) return null;
  return SHEET_SIZES[idx + 1]!;
}

export function sheetByKey(key: string): (SheetSize & { meters: number }) | undefined {
  return SHEET_SIZES.find((s) => s.key === key);
}

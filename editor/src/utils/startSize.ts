import { SHEET_WIDTH_MM } from "../config/sheets";
import { EDGE_MARGIN_MM } from "./layout";

/** A fresh design that says nothing of its size fits in 10 × 10 cm. */
export const DEFAULT_BOX_MM = { w: 100, h: 100 };

/** The widest a design prints: the film less its edge margins. */
const PRINTABLE_WIDTH_MM = SHEET_WIDTH_MM - 2 * EDGE_MARGIN_MM;

/**
 * The size a fresh upload starts at, in mm: the size the file was made at
 * when it gives one (the upload's `fileSizeMm`), narrowed to the film. A
 * logo drawn 40 cm wide used to start at 10 cm, and made 40 cm again it
 * warned of low DPI. Without a size of its own, or under 3 cm, a design
 * fits inside 10 × 10 cm as before.
 */
export function startSizeMm(
  fileSizeMm: { width: number; height: number } | null | undefined,
  widthPx: number,
  heightPx: number,
): { width: number; height: number; fromFile: boolean } {
  const ratio = heightPx / Math.max(1, widthPx);
  if (fileSizeMm && Math.max(fileSizeMm.width, fileSizeMm.height) >= 30) {
    const width = Math.min(fileSizeMm.width, PRINTABLE_WIDTH_MM);
    return { width, height: width * ratio, fromFile: true };
  }
  const width = Math.min(DEFAULT_BOX_MM.w, DEFAULT_BOX_MM.h / ratio);
  return { width, height: width * ratio, fromFile: false };
}

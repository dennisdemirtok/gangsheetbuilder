// Conversion utilities for mm, px, and inches

const EXPORT_DPI = 300;

export function mmToPx(mm: number, dpi: number = EXPORT_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}

export function pxToMm(px: number, dpi: number = EXPORT_DPI): number {
  return (px * 25.4) / dpi;
}

export function mmToCanvasPx(mm: number, scaleFactor: number): number {
  return mm * scaleFactor;
}

export function canvasPxToMm(px: number, scaleFactor: number): number {
  return px / scaleFactor;
}

export function calculateScaleFactor(
  sheetWidthMm: number,
  sheetHeightMm: number,
  viewportWidth: number,
  viewportHeight: number,
  padding: number = 40,
): number {
  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;
  const scaleX = availableWidth / sheetWidthMm;
  const scaleY = availableHeight / sheetHeightMm;
  return Math.min(scaleX, scaleY);
}

export function calculateDisplayDpi(
  originalWidthPx: number,
  displayWidthMm: number,
): number {
  if (displayWidthMm <= 0) return 0;
  const displayWidthInches = displayWidthMm / 25.4;
  return Math.round(originalWidthPx / displayWidthInches);
}

/**
 * Get DPI quality level matching competitor's color coding.
 */
export type DpiLevel = "optimal" | "good" | "bad" | "terrible";

export function getDpiLevel(dpi: number): DpiLevel {
  if (dpi >= 300) return "optimal";
  if (dpi >= 250) return "good";
  if (dpi >= 200) return "bad";
  return "terrible";
}

export function getDpiColor(dpi: number): string {
  const level = getDpiLevel(dpi);
  return DPI_LEVEL_COLORS[level];
}

export const DPI_LEVEL_COLORS: Record<DpiLevel, string> = {
  optimal: "#22c55e",  // Green
  good: "#f59e0b",     // Yellow
  bad: "#ef4444",      // Red
  terrible: "#1a1a1a", // Black
};

// Backwards compatibility
export function getDpiQuality(dpi: number): "good" | "warning" | "bad" {
  if (dpi >= 250) return "good";
  if (dpi >= 200) return "warning";
  return "bad";
}

export const DPI_COLORS = {
  good: "#22c55e",
  warning: "#f59e0b",
  bad: "#ef4444",
};

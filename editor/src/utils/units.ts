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
 * DPI quality bands, calibrated for DTF rather than offset print.
 * 300 is ideal, but DTF film still holds detail well down to ~200, and
 * 150 prints acceptably for large motifs — flagging 229 DPI as "bad"
 * only scares customers off designs that would have printed fine.
 * Below 150 the result is visibly soft and deserves a real warning.
 */
export type DpiLevel = "optimal" | "good" | "low" | "bad";

export const DPI_THRESHOLDS = {
  optimal: 300,
  good: 200,
  low: 150,
} as const;

export function getDpiLevel(dpi: number): DpiLevel {
  if (dpi >= DPI_THRESHOLDS.optimal) return "optimal";
  if (dpi >= DPI_THRESHOLDS.good) return "good";
  if (dpi >= DPI_THRESHOLDS.low) return "low";
  return "bad";
}

export function getDpiColor(dpi: number): string {
  const level = getDpiLevel(dpi);
  return DPI_LEVEL_COLORS[level];
}

export const DPI_LEVEL_COLORS: Record<DpiLevel, string> = {
  optimal: "#16a34a", // Green
  good: "#65a30d",    // Lime — fine for DTF
  low: "#f59e0b",     // Amber — usable, but soft up close
  bad: "#ef4444",     // Red — will look blurry
};

export const DPI_LEVEL_LABELS: Record<DpiLevel, string> = {
  optimal: "Perfekt",
  good: "Bra",
  low: "OK",
  bad: "För låg",
};

/** Warning text for a design that is below the comfortable band, else null. */
export function dpiWarning(dpi: number): string | null {
  const level = getDpiLevel(dpi);
  if (level === "bad") {
    return `${dpi} DPI — bilden blir suddig i tryck. Ladda upp en större fil eller gör motivet mindre.`;
  }
  if (level === "low") {
    return `${dpi} DPI — fungerar för större motiv, men detaljer kan bli mjuka.`;
  }
  return null;
}

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

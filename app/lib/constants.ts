// Sheet width is always 580mm (58cm), height varies by meter
export const SHEET_WIDTH_MM = 580;

export const SHEET_SIZES = [
  { key: "58x100", widthMm: 580, heightMm: 1000, label: "1 meter (58×100 cm)", meters: 1 },
  { key: "58x200", widthMm: 580, heightMm: 2000, label: "2 meter (58×200 cm)", meters: 2 },
  { key: "58x300", widthMm: 580, heightMm: 3000, label: "3 meter (58×300 cm)", meters: 3 },
  { key: "58x400", widthMm: 580, heightMm: 4000, label: "4 meter (58×400 cm)", meters: 4 },
  { key: "58x500", widthMm: 580, heightMm: 5000, label: "5 meter (58×500 cm)", meters: 5 },
] as const;

// 200 kr per meter
export const DEFAULT_PRICES_SEK: Record<string, number> = {
  "58x100": 200,
  "58x200": 400,
  "58x300": 600,
  "58x400": 800,
  "58x500": 1000,
};

export const FILM_TYPES = [
  { key: "standard", label: "Standard", modifier: 1.0 },
  { key: "glitter", label: "Glitter", modifier: 1.5 },
  { key: "glow", label: "Glow-in-the-Dark", modifier: 1.3 },
  { key: "gold_foil", label: "Gold Foil", modifier: 1.8 },
  { key: "silver_foil", label: "Silver Foil", modifier: 1.8 },
] as const;

export const DEFAULT_FILM_MODIFIERS: Record<string, number> = {
  standard: 1.0,
  glitter: 1.5,
  glow: 1.3,
  gold_foil: 1.8,
  silver_foil: 1.8,
};

// Export DPI — DTF standard is 300 DPI
export const EXPORT_DPI = 300;

// DPI thresholds for quality indicators (same as competitor)
export const DPI_OPTIMAL = 300; // Green
export const DPI_GOOD = 250;    // Yellow
export const DPI_BAD = 200;     // Red
export const DPI_TERRIBLE = 72; // Black
export const DPI_MIN = 72;

// Default gap between designs in mm
export const DEFAULT_GAP_MM = 5;

// Default margin per image in mm
export const DEFAULT_MARGIN_MM = 5;

// Max file upload size in bytes (50 MB)
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB

// Allowed file extensions
export const ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "svg", "pdf", "tiff", "tif",
  "webp", "eps", "ai", "bmp", "avif",
] as const;

// Convert mm to pixels at given DPI
export function mmToPx(mm: number, dpi: number = EXPORT_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}

// Convert pixels to mm at given DPI
export function pxToMm(px: number, dpi: number = EXPORT_DPI): number {
  return (px * 25.4) / dpi;
}

// Gang sheet status flow
export type GangSheetStatus = "draft" | "pending" | "exported" | "downloaded" | "printed";

export const STATUS_LABELS: Record<GangSheetStatus, string> = {
  draft: "Utkast",
  pending: "Väntar",
  exported: "Exporterad",
  downloaded: "Nedladdad",
  printed: "Utskriven",
};

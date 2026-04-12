import { fileTypeFromBuffer } from "file-type";
import { MAX_FILE_SIZE_BYTES } from "./constants";

export interface ValidationResult {
  valid: boolean;
  mimeType?: string;
  extension?: string;
  error?: string;
  needsConversion?: boolean;
}

// All MIME types we accept
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/bmp",
  "image/avif",
  "application/pdf",
  "application/postscript", // EPS, AI
  "application/eps",
  "application/x-eps",
  "image/x-eps",
]);

// Extensions we support (case insensitive)
const ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "svg", "svgz",
  "tiff", "tif", "webp", "bmp", "avif",
  "pdf", "eps", "ai",
]);

// Formats that need conversion to PNG before processing
const CONVERSION_FORMATS = new Set([
  "image/tiff", "image/webp", "image/bmp", "image/avif",
  "application/postscript", "application/eps",
  "application/x-eps", "image/x-eps",
]);

export async function validateFile(
  buffer: Buffer,
  filename: string,
  maxSizeBytes: number = MAX_FILE_SIZE_BYTES,
): Promise<ValidationResult> {
  // Check file size
  if (buffer.length > maxSizeBytes) {
    return {
      valid: false,
      error: `Filen är för stor (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max ${(maxSizeBytes / 1024 / 1024).toFixed(0)} MB.`,
    };
  }

  if (buffer.length === 0) {
    return { valid: false, error: "Filen är tom." };
  }

  // Get extension from filename
  const ext = filename.split(".").pop()?.toLowerCase();

  // SVG files are text-based and won't be detected by magic bytes
  if (!ext) {
    return { valid: false, error: "Filen saknar filändelse." };
  }

  if (ext === "svg" || ext === "svgz") {
    const text = buffer.toString("utf-8", 0, Math.min(buffer.length, 1024));
    if (text.includes("<svg") || text.includes("<?xml")) {
      return { valid: true, mimeType: "image/svg+xml", extension: "svg" };
    }
    return { valid: false, error: "Ogiltig SVG-fil." };
  }

  // EPS/AI files — check for PostScript header
  if (ext === "eps" || ext === "ai") {
    const header = buffer.toString("ascii", 0, Math.min(buffer.length, 32));
    if (
      header.startsWith("%!PS") ||
      header.startsWith("%!Adobe") ||
      buffer[0] === 0xc5 // Binary EPS
    ) {
      return {
        valid: true,
        mimeType: "application/postscript",
        extension: ext,
        needsConversion: true,
      };
    }
    // AI files can also be PDF-based
    if (header.startsWith("%PDF")) {
      return {
        valid: true,
        mimeType: "application/pdf",
        extension: "pdf",
        needsConversion: true,
      };
    }
    return { valid: false, error: `Ogiltig ${ext.toUpperCase()}-fil.` };
  }

  // Detect MIME type from magic bytes
  const fileType = await fileTypeFromBuffer(buffer);

  if (!fileType) {
    return {
      valid: false,
      error: `Kunde inte identifiera filtyp för "${filename}".`,
    };
  }

  // Check against allowed MIME types
  if (!ALLOWED_MIME_TYPES.has(fileType.mime) && !ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `Filtypen ${fileType.mime} stöds inte. Tillåtna: PNG, JPG, SVG, TIFF, PDF, EPS, WebP.`,
    };
  }

  return {
    valid: true,
    mimeType: fileType.mime,
    extension: fileType.ext,
    needsConversion: CONVERSION_FORMATS.has(fileType.mime),
  };
}

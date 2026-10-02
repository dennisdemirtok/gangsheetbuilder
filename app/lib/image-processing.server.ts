import sharp from "sharp";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export interface ImageMetadata {
  width: number;
  height: number;
  dpiX: number;
  dpiY: number;
  format: string;
  hasAlpha: boolean;
  hasWhiteBackground: boolean;
  colorSpace: string;
  channels: number;
  fileSize: number;
}

/**
 * Extract metadata (dimensions, DPI, format, background analysis) from an image buffer.
 */
export async function extractMetadata(buffer: Buffer): Promise<ImageMetadata> {
  const metadata = await sharp(buffer).metadata();
  const dpi = metadata.density || 72;
  const hasAlpha = metadata.hasAlpha || false;

  // Analyze if image likely has a white background
  const hasWhiteBg = await detectWhiteBackground(buffer, hasAlpha);

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    dpiX: dpi,
    dpiY: dpi,
    format: metadata.format || "unknown",
    hasAlpha,
    hasWhiteBackground: hasWhiteBg,
    colorSpace: metadata.space || "srgb",
    channels: metadata.channels || 3,
    fileSize: buffer.length,
  };
}

/**
 * Detect if an image likely has a white (or near-white) background.
 * Samples corner pixels and edge regions.
 * Returns true if the background appears to be white/light.
 */
async function detectWhiteBackground(
  buffer: Buffer,
  hasAlpha: boolean,
): Promise<boolean> {
  if (hasAlpha) {
    // If image has alpha channel, check if it's actually used
    const stats = await sharp(buffer).stats();
    const alphaChannel = stats.channels[3];
    if (alphaChannel && alphaChannel.min < 200) {
      // Alpha is used (some transparency), likely no white bg issue
      return false;
    }
  }

  try {
    const img = sharp(buffer);
    const meta = await img.metadata();
    const w = meta.width || 100;
    const h = meta.height || 100;

    // Sample 4 corners (10x10 px each) and check if they're white
    const cornerSize = Math.min(10, Math.floor(w / 10), Math.floor(h / 10));
    if (cornerSize < 2) return false;

    const corners = [
      { left: 0, top: 0 }, // top-left
      { left: w - cornerSize, top: 0 }, // top-right
      { left: 0, top: h - cornerSize }, // bottom-left
      { left: w - cornerSize, top: h - cornerSize }, // bottom-right
    ];

    let whiteCorners = 0;

    for (const corner of corners) {
      const region = await sharp(buffer)
        .extract({
          left: corner.left,
          top: corner.top,
          width: cornerSize,
          height: cornerSize,
        })
        .raw()
        .toBuffer();

      const channels = meta.channels || 3;
      let totalBrightness = 0;
      const pixelCount = (region.length / channels);

      for (let i = 0; i < region.length; i += channels) {
        const r = region[i]!;
        const g = region[i + 1]!;
        const b = region[i + 2]!;
        totalBrightness += (r + g + b) / 3;
      }

      const avgBrightness = totalBrightness / pixelCount;
      // White threshold: average brightness > 240 (out of 255)
      if (avgBrightness > 240) {
        whiteCorners++;
      }
    }

    // If 3 or more corners are white, likely a white background
    return whiteCorners >= 3;
  } catch {
    return false;
  }
}

/**
 * Convert EPS/AI/PDF to PNG using Ghostscript.
 * Returns a PNG buffer that Sharp can process.
 */
export async function convertToRaster(
  buffer: Buffer,
  filename: string,
  dpi: number = 300,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "gs-convert-"));
  const ext = filename.split(".").pop()?.toLowerCase() || "eps";
  const inputPath = join(dir, `input.${ext}`);
  const outputPath = join(dir, "output.png");

  await writeFile(inputPath, buffer);

  return new Promise((resolve, reject) => {
    execFile(
      "gs",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dEPSCrop",
        "-sDEVICE=pngalpha",
        `-r${dpi}`,
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      { timeout: 30000 },
      async (error) => {
        try {
          if (error) {
            console.error("Ghostscript conversion error:", error.message);
            reject(new Error("Kunde inte konvertera filen: " + error.message));
            return;
          }
          const pngBuffer = await readFile(outputPath);
          resolve(pngBuffer);
        } finally {
          // Cleanup
          await unlink(inputPath).catch(() => {});
          await unlink(outputPath).catch(() => {});
          await unlink(dir).catch(() => {});
        }
      },
    );
  });
}

/**
 * Check if a file needs Ghostscript conversion.
 */
export function needsGhostscript(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["eps", "ai", "ps"].includes(ext);
}

/**
 * Generate a WebP thumbnail for canvas display.
 */
export async function generateThumbnail(
  buffer: Buffer,
  maxWidth: number = 800,
): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Convert various image formats to PNG for processing.
 * Handles TIFF, WebP, AVIF, BMP, and other formats Sharp supports.
 */
export async function convertToPng(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).png().toBuffer();
}

/**
 * Remove the white background around a design.
 *
 * Only white that is connected to the edge of the image is removed — the
 * background. This used to clear every near-white pixel, so white text and
 * white details inside a logo turned transparent too, and in DTF they would
 * print in the colour of the garment instead of white. Anti-aliased edges
 * against the background fade out instead of leaving a white halo.
 */
export async function removeWhiteBackground(
  buffer: Buffer,
  threshold: number = 240,
  fuzz: number = 20,
): Promise<Buffer> {
  const img = sharp(buffer, { limitInputPixels: false });
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  if (w === 0 || h === 0) return buffer;

  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // 4 (RGBA)
  const loose = threshold - fuzz;

  /** Near-white and still visible: part of the background if it touches it. */
  const whiteish = (p: number) => {
    const i = p * channels;
    return (
      data[i + 3]! > 0 &&
      data[i]! >= loose &&
      data[i + 1]! >= loose &&
      data[i + 2]! >= loose
    );
  };

  const clear = (p: number) => {
    const i = p * channels;
    const whiteness = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    data[i + 3] =
      whiteness >= threshold
        ? 0
        : Math.max(0, Math.min(255, Math.round(255 * (1 - (whiteness - loose) / fuzz))));
  };

  // Scanline flood fill from every white pixel on the border. A span stack
  // stays small even on 40-megapixel EPS renders, unlike a pixel stack.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const p = y * w + x;
    if (!seen[p] && whiteish(p)) stack.push(x, y);
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }

  while (stack.length > 0) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * w + x;
    if (seen[p]) continue;
    // Walk left to the start of this run of background.
    while (x > 0 && !seen[p - 1] && whiteish(p - 1)) {
      x--;
      p--;
    }
    let aboveOpen = false;
    let belowOpen = false;
    for (; x < w && !seen[p] && whiteish(p); x++, p++) {
      seen[p] = 1;
      clear(p);
      if (y > 0) {
        const up = p - w;
        const open = !seen[up] && whiteish(up);
        if (open && !aboveOpen) stack.push(x, y - 1);
        aboveOpen = open;
      }
      if (y < h - 1) {
        const down = p + w;
        const open = !seen[down] && whiteish(down);
        if (open && !belowOpen) stack.push(x, y + 1);
        belowOpen = open;
      }
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();
}

/**
 * Calculate actual DPI when placing an image at a given display size.
 */
export function calculateDisplayDpi(
  originalWidthPx: number,
  displayWidthMm: number,
): number {
  const displayWidthInches = displayWidthMm / 25.4;
  return Math.round(originalWidthPx / displayWidthInches);
}

export interface CompositeImage {
  buffer: Buffer;
  x: number; // px, top-left of the rotated bounding box
  y: number; // px
  width: number; // px, UNROTATED display width
  height: number; // px, UNROTATED display height
  rotation: number; // degrees clockwise
  flipX: boolean;
  flipY: boolean;
}

/**
 * Render a single placed image per the shared placement contract:
 * resize to unrotated display size → flip/flop (object space) →
 * rotate with transparent background. The resulting buffer IS the
 * axis-aligned bounding box of the placed image.
 */
export async function renderPlacedImage(img: {
  buffer: Buffer;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}): Promise<Buffer> {
  // Pass 1: resize to the unrotated display size.
  const resized = await sharp(img.buffer, { limitInputPixels: false })
    .resize(img.width, img.height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  if (!img.flipX && !img.flipY && img.rotation % 360 === 0) {
    return resized;
  }

  // Pass 2: flip/flop then rotate. sharp always applies flip/flop before
  // rotation within a pipeline, matching Fabric.js flip-then-rotate order.
  let processed = sharp(resized, { limitInputPixels: false });
  if (img.flipX) processed = processed.flop();
  if (img.flipY) processed = processed.flip();
  if (img.rotation % 360 !== 0) {
    processed = processed.rotate(img.rotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  return processed.png().toBuffer();
}

/**
 * Composite multiple images onto a transparent canvas at the specified dimensions.
 * Used for final export at 300 DPI.
 */
export async function compositeGangSheet(
  images: CompositeImage[],
  canvasWidthPx: number,
  canvasHeightPx: number,
): Promise<Buffer> {
  const canvas = sharp({
    create: {
      width: canvasWidthPx,
      height: canvasHeightPx,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
    limitInputPixels: false,
  });

  const compositeInputs: sharp.OverlayOptions[] = [];

  for (const img of images) {
    const processedBuffer = await renderPlacedImage(img);

    const left = Math.round(img.x);
    const top = Math.round(img.y);

    const meta = await sharp(processedBuffer, {
      limitInputPixels: false,
    }).metadata();
    const bboxW = meta.width || 0;
    const bboxH = meta.height || 0;

    // sharp cannot composite overlays outside the canvas — skip and warn.
    if (
      left < 0 ||
      top < 0 ||
      left + bboxW > canvasWidthPx ||
      top + bboxH > canvasHeightPx
    ) {
      console.warn(
        `[export] Skipping copy outside canvas: left=${left}, top=${top}, bbox=${bboxW}x${bboxH}, canvas=${canvasWidthPx}x${canvasHeightPx}`,
      );
      continue;
    }

    compositeInputs.push({
      input: processedBuffer,
      left,
      top,
    });
  }

  // Set 300 DPI metadata in the output
  return canvas
    .composite(compositeInputs)
    .png()
    .withMetadata({ density: 300 })
    .toBuffer();
}

/**
 * Generate a low-resolution preview image from the composite.
 */
export async function generatePreview(
  compositeBuffer: Buffer,
  maxWidth: number = 1200,
): Promise<Buffer> {
  return sharp(compositeBuffer, { limitInputPixels: false })
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

/**
 * Ensure exported PNG has correct 300 DPI metadata.
 */
export async function setDpiMetadata(
  buffer: Buffer,
  dpi: number = 300,
): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: false })
    .withMetadata({ density: dpi })
    .png()
    .toBuffer();
}

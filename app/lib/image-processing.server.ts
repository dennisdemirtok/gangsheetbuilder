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
 * Does the design sit on a white background that would print as a white
 * box? Answered by the removal itself, on a small copy: if clearing the
 * white that touches the edge (through any transparent margin) would clear
 * more than a sliver of the image, there is a background.
 *
 * This used to give up as soon as the file had any transparency, and only
 * looked at the four corners — so an EPS whose white box sits inside a
 * transparent margin (Ghostscript renders the page that way) was never
 * flagged, and printed with its box.
 */
async function detectWhiteBackground(
  buffer: Buffer,
  _hasAlpha: boolean,
): Promise<boolean> {
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: false })
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cleared = clearEdgeWhite(data, info.width, info.height, info.channels, 240, 20);
    return cleared > info.width * info.height * 0.03;
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
  if (!meta.width || !meta.height) return buffer;

  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  clearEdgeWhite(data, info.width, info.height, info.channels, threshold, fuzz);

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();
}

/**
 * Cut away empty transparent margins around a design.
 *
 * Files often carry a lot of empty canvas around the artwork — in real
 * uploads a median 13 %, up to 65 %. The customer sizes the file, not the
 * logo, so "10 cm" printed a smaller logo and the margin took film. Only
 * transparent edges are cut: a white margin on an opaque file may be part
 * of the design. Returns the input untouched when there is nothing to cut.
 */
export async function trimTransparentEdges(
  buffer: Buffer,
): Promise<{ buffer: Buffer; trimmed: boolean; width: number; height: number }> {
  const img = sharp(buffer, { limitInputPixels: false });
  const meta = await img.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!meta.hasAlpha || width === 0 || height === 0) return { buffer, trimmed: false, width, height };

  // Against full transparency, so a logo touching the top-left corner is
  // not taken for background.
  const { data, info } = await sharp(buffer, { limitInputPixels: false })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
    .png()
    .toBuffer({ resolveWithObject: true })
    .catch(() => ({ data: buffer, info: { width, height } as sharp.OutputInfo }));

  // A sliver is not worth re-encoding the file for.
  if (info.width >= width - 2 && info.height >= height - 2) {
    return { buffer, trimmed: false, width, height };
  }
  return { buffer: data, trimmed: true, width: info.width, height: info.height };
}

/**
 * Make every near-white pixel transparent — also white inside the design,
 * like the counter of an "O". Only on request: it also clears white the
 * design is meant to print. The customer sees the result before using it.
 */
export async function removeAllWhite(
  buffer: Buffer,
  threshold: number = 240,
  fuzz: number = 20,
): Promise<Buffer> {
  const { data, info } = await sharp(buffer, { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const loose = threshold - fuzz;
  for (let i = 0; i < data.length; i += info.channels) {
    const whiteness = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    if (whiteness < loose) continue;
    const a = whiteness >= threshold ? 0 : Math.round(255 * (1 - (whiteness - loose) / fuzz));
    data[i + 3] = Math.min(data[i + 3]!, Math.max(0, a));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

/**
 * Make a white background transparent, in place. Returns how many visible
 * white pixels it cleared (0 when there is no white background).
 *
 * A white background is a frame around the design: the edge of everything
 * visible in the file is mostly white. That covers a JPG on white paper and
 * an EPS whose white box sits inside a transparent margin (Ghostscript
 * renders the page that way, and a fill that started at the file's own edge
 * never reached the box). A white logo on a transparent background has a
 * mostly transparent edge and is left alone — clearing "white connected to
 * the edge" through the transparency would have erased it. From the white
 * on that edge, white connected to it is cleared; white inside the design
 * (text, details) stays and prints white. A scanline fill keeps the stack
 * small even on 40-megapixel renders.
 */
function clearEdgeWhite(
  data: Buffer,
  w: number,
  h: number,
  channels: number,
  threshold: number,
  fuzz: number,
): number {
  const loose = threshold - fuzz;
  const VISIBLE = 16;
  const alpha = (p: number) => data[p * channels + 3]!;
  const isWhite = (p: number) => {
    const i = p * channels;
    return (
      data[i + 3]! >= VISIBLE &&
      data[i]! >= loose &&
      data[i + 1]! >= loose &&
      data[i + 2]! >= loose
    );
  };

  // Bounds of everything visible.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha(row + x) >= VISIBLE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return 0;

  // Is the edge of the visible area mostly white — a frame?
  const edge: number[] = [];
  for (let x = minX; x <= maxX; x++) edge.push(minY * w + x, maxY * w + x);
  for (let y = minY + 1; y < maxY; y++) edge.push(y * w + minX, y * w + maxX);
  const whiteOnEdge = edge.filter(isWhite);
  if (whiteOnEdge.length < edge.length * 0.5) return 0;

  let cleared = 0;
  const clear = (p: number) => {
    const i = p * channels;
    const whiteness = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    data[i + 3] =
      whiteness >= threshold
        ? 0
        : Math.max(0, Math.min(255, Math.round(255 * (1 - (whiteness - loose) / fuzz))));
    cleared++;
  };

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const p of whiteOnEdge) stack.push(p % w, Math.floor(p / w));

  while (stack.length > 0) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * w + x;
    if (seen[p] || !isWhite(p)) continue;
    // Walk left to the start of this run of white.
    while (x > 0 && !seen[p - 1] && isWhite(p - 1)) {
      x--;
      p--;
    }
    let aboveOpen = false;
    let belowOpen = false;
    for (; x < w && !seen[p] && isWhite(p); x++, p++) {
      seen[p] = 1;
      if (y > 0) {
        const up = p - w;
        const open = !seen[up] && isWhite(up);
        if (open && !aboveOpen) stack.push(x, y - 1);
        aboveOpen = open;
      }
      if (y < h - 1) {
        const down = p + w;
        const open = !seen[down] && isWhite(down);
        if (open && !belowOpen) stack.push(x, y + 1);
        belowOpen = open;
      }
    }
  }
  // Clear after the fill, so partial alphas don't change what counts as white.
  for (let p = 0; p < seen.length; p++) if (seen[p]) clear(p);
  return cleared;
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

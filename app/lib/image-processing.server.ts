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
  /**
   * The colour of a solid background around the design (#rrggbb) — white,
   * black or any one colour — or null when there is none.
   */
  backgroundColor?: string | null;
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

  // A solid background that would print as a box around the design.
  const background = await detectBackground(buffer);

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    dpiX: dpi,
    dpiY: dpi,
    format: metadata.format || "unknown",
    hasAlpha,
    hasWhiteBackground: background !== null && isWhite(background),
    backgroundColor: background ? toHex(background) : null,
    colorSpace: metadata.space || "srgb",
    channels: metadata.channels || 3,
    fileSize: buffer.length,
  };
}

/**
 * The colour of the background the design sits on, when it would print as
 * a box around it. Answered by the removal itself, on a small copy: if
 * clearing the background that touches the edge (through any transparent
 * margin) would clear more than a sliver of the image, there is one.
 *
 * Only white counted until now, so a logo on black came through without a
 * word and printed as a black box.
 */
async function detectBackground(buffer: Buffer): Promise<Rgb | null> {
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: false })
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { cleared, color } = clearEdgeBackground(data, info.width, info.height, info.channels);
    return color && cleared > info.width * info.height * 0.03 ? color : null;
  } catch {
    return null;
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
 * Remove the solid background around a design: white, black or any one
 * colour, whichever frames it.
 *
 * Only background connected to the edge of the image is removed. This used
 * to clear every near-white pixel, so white text and white details inside a
 * logo turned transparent too, and in DTF they would print in the colour of
 * the garment instead of white. Anti-aliased edges against the background
 * fade out instead of leaving a halo.
 */
export async function removeBackground(buffer: Buffer): Promise<Buffer> {
  const img = sharp(buffer, { limitInputPixels: false });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return buffer;

  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  clearEdgeBackground(data, info.width, info.height, info.channels);

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
 * Make every pixel of the background's colour transparent — also inside
 * the design, like the counter of an "O". Only on request: it also clears
 * what the design is meant to print in that colour. The customer sees the
 * result before using it. White when no background colour is found.
 */
export async function removeAllOfColor(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer, { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const color = frameColor(data, info.width, info.height, info.channels)?.color ?? WHITE;
  for (let i = 0; i < data.length; i += info.channels) {
    const d = distanceAt(data, i, color);
    if (d > LOOSE) continue;
    const a = d <= TIGHT ? 0 : Math.round((255 * (d - TIGHT)) / (LOOSE - TIGHT));
    data[i + 3] = Math.min(data[i + 3]!, a);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
/** Within this of the background colour (per channel): cleared. */
const TIGHT = 15;
/** Up to this: faded, the anti-aliased edge of the design. */
const LOOSE = 35;
/** Alpha below this is not part of the picture. */
const VISIBLE = 16;

function distanceAt(data: Buffer, i: number, c: Rgb): number {
  return Math.max(Math.abs(data[i]! - c[0]), Math.abs(data[i + 1]! - c[1]), Math.abs(data[i + 2]! - c[2]));
}

function isWhite(c: Rgb): boolean {
  return Math.min(c[0], c[1], c[2]) >= 235;
}

function toHex(c: Rgb): string {
  return "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * The colour most of the edge of everything visible has, when one colour
 * makes up at least half of it — a frame. Null for a design on
 * transparency (its edge is mostly see-through) or a photo (many colours).
 */
function frameColor(
  data: Buffer,
  w: number,
  h: number,
  channels: number,
): { color: Rgb; edge: number[] } | null {
  const alpha = (p: number) => data[p * channels + 3]!;
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
  if (maxX < 0) return null;

  const edge: number[] = [];
  for (let x = minX; x <= maxX; x++) edge.push(minY * w + x, maxY * w + x);
  for (let y = minY + 1; y < maxY; y++) edge.push(y * w + minX, y * w + maxX);

  // Coarse buckets, so JPEG noise and a little shading stay one colour.
  const buckets = new Map<number, number[]>();
  for (const p of edge) {
    if (alpha(p) < VISIBLE) continue;
    const i = p * channels;
    const key = ((data[i]! >> 5) << 6) | ((data[i + 1]! >> 5) << 3) | (data[i + 2]! >> 5);
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }
  let best: number[] = [];
  for (const list of buckets.values()) if (list.length > best.length) best = list;
  if (best.length < edge.length * 0.5) return null;

  const sum = [0, 0, 0];
  for (const p of best) {
    const i = p * channels;
    sum[0] += data[i]!;
    sum[1] += data[i + 1]!;
    sum[2] += data[i + 2]!;
  }
  return { color: [sum[0]! / best.length, sum[1]! / best.length, sum[2]! / best.length], edge };
}

/**
 * Make a solid background transparent, in place. Returns how many visible
 * pixels it cleared (0 when there is no background) and its colour.
 *
 * A background is a frame around the design: the edge of everything
 * visible in the file is mostly one colour. That covers a JPG on white
 * paper, a logo on a black square, and an EPS whose white box sits inside a
 * transparent margin (Ghostscript renders the page that way, and a fill
 * that started at the file's own edge never reached the box). A white logo
 * on a transparent background has a mostly transparent edge and is left
 * alone — clearing "white connected to the edge" through the transparency
 * would have erased it. From the background on that edge, what is
 * connected to it is cleared; the same colour inside the design (text,
 * details) stays and prints. A scanline fill keeps the stack small even on
 * 40-megapixel renders.
 */
function clearEdgeBackground(
  data: Buffer,
  w: number,
  h: number,
  channels: number,
): { cleared: number; color: Rgb | null } {
  const frame = frameColor(data, w, h, channels);
  if (!frame) return { cleared: 0, color: null };
  const { color } = frame;
  const isBackground = (p: number) => {
    const i = p * channels;
    return data[i + 3]! >= VISIBLE && distanceAt(data, i, color) <= LOOSE;
  };

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const p of frame.edge) if (isBackground(p)) stack.push(p % w, Math.floor(p / w));

  while (stack.length > 0) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * w + x;
    if (seen[p] || !isBackground(p)) continue;
    // Walk left to the start of this run of background.
    while (x > 0 && !seen[p - 1] && isBackground(p - 1)) {
      x--;
      p--;
    }
    let aboveOpen = false;
    let belowOpen = false;
    for (; x < w && !seen[p] && isBackground(p); x++, p++) {
      seen[p] = 1;
      if (y > 0) {
        const up = p - w;
        const open = !seen[up] && isBackground(up);
        if (open && !aboveOpen) stack.push(x, y - 1);
        aboveOpen = open;
      }
      if (y < h - 1) {
        const down = p + w;
        const open = !seen[down] && isBackground(down);
        if (open && !belowOpen) stack.push(x, y + 1);
        belowOpen = open;
      }
    }
  }

  // Clear after the fill, so partial alphas don't change what counts as background.
  let cleared = 0;
  for (let p = 0; p < seen.length; p++) {
    if (!seen[p]) continue;
    const i = p * channels;
    const d = distanceAt(data, i, color);
    data[i + 3] = d <= TIGHT ? 0 : Math.min(data[i + 3]!, Math.round((255 * (d - TIGHT)) / (LOOSE - TIGHT)));
    cleared++;
  }
  return { cleared, color };
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

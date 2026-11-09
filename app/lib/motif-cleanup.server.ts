import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  backgroundColorOf,
  embedsPictures,
  needsGhostscript,
  removeAllOfColor,
  removeBackground,
  trimTransparentEdges,
  type Rgb as Rgb3,
} from "./image-processing.server";

/**
 * Two fixes for the files customers send, offered to them in the builder
 * and on the By Size page, and to the shop on the order page:
 *
 * - Remove the background: a white (or any one-colour) box around the
 *   motif made transparent. The same fill from the edge as the builder's
 *   "Ta bort BG", here also for PDF, EPS and AI, which the browser cannot
 *   read — #1153 sent two PDFs on white and asked in the comment.
 * - Sharpen a logo: a flat logo saved small or as a JPG (#1151: a 1024 px
 *   logo printed 166 mm wide, stair-stepped edges and a light rim) traced
 *   into shapes with potrace, one per colour, and drawn again large. Free
 *   and about two seconds; an AI model would redraw the letters. Photos,
 *   paintings and gradients are refused: tracing would posterise them.
 */

const run = promisify(execFile);

/** Alpha from which a pixel counts as part of the motif. */
const SOLID = 128;
/** Longest side the colours are worked out and traced at. */
const MAX_TRACE = 2500;
/** A smaller file is drawn up to this (at most 4×) before tracing. */
const MIN_TRACE = 1500;
/** The widest blend between motif and background that cleanRim looks for, in pixels. */
const MAX_RIM = 32;
/**
 * A blend wider than this is no edge but the picture itself: a painting on
 * a dark ground or a photo rises slowly from the background for 20–30 px,
 * an edge (#1153's 374 px picture drawn 4.4× larger: 9 px) levels off.
 */
const MAX_BAND = 16;
/** At most this many colours; a logo with more is not flat. */
const MAX_COLORS = 8;
/**
 * How far from its own colour one colour's pixels may lie on average. The
 * mean over the whole motif hides shading: #1189's embossed emblem is mostly
 * pale background, came in at an error of 9.47 and had its letters flattened.
 * One of its five colours spread 35. In the files of November's orders, flat
 * logos stayed under 13.4; above 14 sat shading, gradients and colours that
 * got merged into another (a yellow nose gone in the red and white).
 */
const MAX_SPREAD = 14;

/**
 * The motif as a PNG to work on: PDF, EPS and AI through Ghostscript, SVG
 * through resvg (the server's libvips cannot read SVG), anything else as
 * it is. `dpi` applies to the vector formats.
 */
export async function motifRaster(buffer: Buffer, filename: string, dpi = 300): Promise<Buffer> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (needsGhostscript(filename)) return ghostscript(buffer, ext, dpi);
  if (ext === "svg") {
    const { Resvg } = await import("@resvg/resvg-js");
    const svg = new Resvg(buffer, { dpi, fitTo: { mode: "zoom", value: dpi / 96 }, background: "rgba(0,0,0,0)" });
    return Buffer.from(svg.render().asPng());
  }
  return sharp(buffer, { limitInputPixels: false, animated: false }).rotate().png().toBuffer();
}

/**
 * A PDF, EPS or AI page as a PNG, with the pictures in it interpolated.
 * Ghostscript draws a picture larger by repeating its pixels: #1153's
 * 374 px JPEG, rendered for 7 cm, had a 4-pixel staircase along the circle
 * once its background was gone.
 */
async function ghostscript(buffer: Buffer, ext: string, dpi: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "motif-gs-"));
  const input = join(dir, `input.${ext || "pdf"}`);
  const output = join(dir, "output.png");
  try {
    await writeFile(input, buffer);
    await run(
      "gs",
      ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop", "-dFirstPage=1", "-dLastPage=1", "-sDEVICE=pngalpha",
        "-dInterpolateControl=-1", `-r${dpi}`, `-sOutputFile=${output}`, input],
      { timeout: 60_000 },
    );
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The size to judge a file at for sharpening (see sharpenLogo), or null
 * when it is shapes only: a vector without pictures prints sharp at any
 * size already. An EPS cannot be looked into cheaply, so it is judged as
 * if it held a picture.
 */
export function sharpenJudgeSize(buffer: Buffer, filename: string): number | null {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (!["eps", "ps", "ai", "pdf", "svg"].includes(ext)) return MAX_TRACE;
  if (ext === "eps" || ext === "ps") return JUDGE_EMBEDDED_PX;
  return embedsPictures(buffer, ext) ? JUDGE_EMBEDDED_PX : null;
}

/** At least 2 % of the picture fully transparent: it already has no background. */
async function isTransparent(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png, { limitInputPixels: false })
    .ensureAlpha()
    .extractChannel(3)
    .resize({ width: 400, height: 400, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 0; i < data.length; i++) if (data[i]! < 8) clear++;
  return clear > info.width * info.height * 0.02;
}

export type BackgroundResult =
  /**
   * `inside`: the share of what is left that still has the background's
   * colour — background shut in by the motif, which the fill from the edge
   * cannot reach: the inside of letters, leaves and rings (a white wreath
   * and text on green, 2026-11-04: green blobs left in "ö", "d" and every
   * leaf). removeMotifColor takes it too.
   */
  | { ok: true; png: Buffer; inside: number; color: Rgb3 | null }
  | { ok: false; reason: "transparent" | "no_background" | "nothing_inside" };

/** From this share of background colour left inside, the customer is offered removeMotifColor. */
export const INSIDE_OFFER = 0.01;

/**
 * The background around the motif made transparent, its rim cleaned (see
 * cleanRim) and, unless `keepCanvas`, the empty margin cut away. Refused
 * when the file is already transparent, or when no one colour frames it
 * (a photo to its edges), since nothing would change.
 */
export async function removeMotifBackground(png: Buffer, keepCanvas = false): Promise<BackgroundResult> {
  if (await isTransparent(png)) return { ok: false, reason: "transparent" };
  const cleared = await removeBackground(png);
  if (!(await isTransparent(cleared))) return { ok: false, reason: "no_background" };
  const clean = await cleanRim(png, cleared);
  const color = await backgroundColorOf(png);
  const inside = color ? await shareOfColor(clean, color) : 0;
  if (keepCanvas) return { ok: true, png: clean, inside, color };
  const trimmed = await trimTransparentEdges(clean);
  return { ok: true, png: trimmed.buffer, inside, color };
}

/**
 * Every pixel of the background's colour made transparent, also where the
 * motif shuts it in: the inside of letters, leaves and rings. Only on the
 * customer's or the shop's request, after seeing removeMotifBackground
 * leave some: it also takes what the motif itself prints in that colour
 * (white text on a black badge on white paper).
 *
 * A file that is transparent already loses its white: #1163 came with the
 * background taken off around green letters and white left in every a, d,
 * g and o, which would print as white blobs on the jacket.
 *
 * The rim is cleaned as in removeMotifBackground, except on white in an
 * opaque file: there what borders the cleared areas inside is often the
 * design's own light shading, which cleanRim would darken (the builder's
 * "all" leaves it too).
 */
export async function removeMotifColor(png: Buffer, keepCanvas = false): Promise<BackgroundResult> {
  const transparent = await isTransparent(png);
  const color: Rgb3 | null = transparent ? [255, 255, 255] : await backgroundColorOf(png);
  if (!color) return { ok: false, reason: "no_background" };
  if ((await shareOfColor(png, color)) < 0.002) return { ok: false, reason: transparent ? "nothing_inside" : "no_background" };
  const cleared = await removeAllOfColor(png, color);
  if (!(await isTransparent(cleared))) return { ok: false, reason: "no_background" };
  const clean = !transparent && Math.min(...color) >= 235 ? cleared : await cleanRim(png, cleared);
  if (keepCanvas) return { ok: true, png: clean, inside: 0, color };
  const trimmed = await trimTransparentEdges(clean);
  return { ok: true, png: trimmed.buffer, inside: 0, color };
}

/** Of what is solid in `png`, the share within JPEG noise of `color`. */
async function shareOfColor(png: Buffer, color: Rgb3): Promise<number> {
  const { data } = await sharp(png, { limitInputPixels: false })
    .ensureAlpha()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true, kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let solid = 0;
  let same = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 250) continue;
    solid++;
    const d = Math.max(Math.abs(data[i]! - color[0]), Math.abs(data[i + 1]! - color[1]), Math.abs(data[i + 2]! - color[2]));
    if (d <= 20) same++;
  }
  return solid > 0 ? same / solid : 0;
}

/**
 * The edge left where a background was taken off: the motif blended into
 * the background it was drawn on, a grey between #1153's black ring and
 * white, printed as a light line round it. In a band along what was
 * cleared, a pixel on the way from the motif's colour (the nearest pixel
 * inside the band) to the background is split into that colour and how
 * much of it there is. Pixels of another colour (a thin outline) stay as
 * they were. Light specks left in the cleared area go too. The canvas stays
 * as it is, so the builder's "Ta bort BG" uses it as well.
 */
export async function cleanRim(original: Buffer, cleared: Buffer): Promise<Buffer> {
  const src = await sharp(original, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: out, info } = await sharp(cleared, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const N = W * H;
  const o = src.data;
  if (src.info.width !== W || src.info.height !== H || N > 30_000_000) return cleared;

  // The background's colour: what the fill cleared.
  const sum = [0, 0, 0];
  let n = 0;
  for (let p = 0; p < N; p += 3) {
    if (out[p * 4 + 3]! >= 8 || o[p * 4 + 3]! < 250) continue;
    sum[0]! += o[p * 4]!;
    sum[1]! += o[p * 4 + 1]!;
    sum[2]! += o[p * 4 + 2]!;
    n++;
  }
  if (n === 0) return cleared;
  const bg = [sum[0]! / n, sum[1]! / n, sum[2]! / n];

  // Steps from the cleared area, up to MAX_RIM.
  const dist = new Uint8Array(N).fill(255);
  let queue = new Int32Array(N);
  let tail = 0;
  for (let p = 0; p < N; p++) if (out[p * 4 + 3]! < 8) (dist[p] = 0), (queue[tail++] = p);
  for (let head = 0; head < tail; head++) {
    const p = queue[head]!;
    if (dist[p]! >= MAX_RIM) continue;
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      if (q < 0 || q >= N || dist[q] !== 255) continue;
      dist[q] = dist[p]! + 1;
      queue[tail++] = q;
    }
  }

  // How wide the blend is: the steps in until the edge stops moving away
  // from the background. A crisp file blends over a pixel or two; a small
  // picture drawn large (#1153: 374 px for 7 cm) over ten or more.
  const away = new Float64Array(MAX_RIM + 1);
  const count = new Float64Array(MAX_RIM + 1);
  for (let p = 0; p < N; p++) {
    const d = dist[p]!;
    if (d === 0 || d > MAX_RIM) continue;
    away[d] += Math.hypot(o[p * 4]! - bg[0]!, o[p * 4 + 1]! - bg[1]!, o[p * 4 + 2]! - bg[2]!);
    count[d]++;
  }
  let peak = 0;
  for (let d = 1; d <= MAX_RIM; d++) if (count[d]! > 0) peak = Math.max(peak, away[d]! / count[d]!);
  let band = MAX_RIM;
  for (let d = 1; d < MAX_RIM; d++) {
    if (count[d]! > 0 && away[d]! / count[d]! >= 0.95 * peak) {
      band = Math.max(2, d);
      break;
    }
  }
  if (band > MAX_BAND) return cleared;

  // The motif's colour for each band pixel: the nearest solid pixel just inside.
  const seed = new Int32Array(N).fill(-1);
  queue = new Int32Array(N);
  tail = 0;
  for (let p = 0; p < N; p++) {
    if (dist[p] === band + 1 && o[p * 4 + 3]! >= 250) (seed[p] = p), (queue[tail++] = p);
  }
  for (let head = 0; head < tail; head++) {
    const p = queue[head]!;
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      if (q < 0 || q >= N || seed[q] !== -1 || dist[q] === 0 || dist[q]! > band) continue;
      seed[q] = seed[p]!;
      queue[tail++] = q;
    }
  }

  for (let p = 0; p < N; p++) {
    const s = seed[p]!;
    if (s < 0 || s === p || dist[p] === 0) continue;
    const i = p * 4;
    const f = [o[s * 4]! - bg[0]!, o[s * 4 + 1]! - bg[1]!, o[s * 4 + 2]! - bg[2]!];
    const v = [o[i]! - bg[0]!, o[i + 1]! - bg[1]!, o[i + 2]! - bg[2]!];
    const ff = f[0]! * f[0]! + f[1]! * f[1]! + f[2]! * f[2]!;
    if (ff < 30 * 30) continue; // the motif's colour is the background's: nothing to split
    const a = Math.max(0, Math.min(1, (v[0]! * f[0]! + v[1]! * f[1]! + v[2]! * f[2]!) / ff));
    const off = Math.hypot(v[0]! - a * f[0]!, v[1]! - a * f[1]!, v[2]! - a * f[2]!);
    if (off > 24) continue; // another colour, not a blend of these two
    // Never more than the fill left: what it faded out stays faded.
    out[i + 3] = Math.min(out[i + 3]!, Math.round(a * o[i + 3]!));
    if (a < 0.97) {
      out[i] = o[s * 4]!;
      out[i + 1] = o[s * 4 + 1]!;
      out[i + 2] = o[s * 4 + 2]!;
    }
  }

  // Specks left in the cleared area: JPEG noise a little too far from the
  // background's colour to be cleared, printed as light dots round the
  // motif. A small island close to the background's colour goes; a small
  // dark dot (part of the design) stays.
  const speck = Math.max(12, Math.round(N / 150_000));
  const seen = new Uint8Array(N);
  const island: number[] = [];
  for (let start = 0; start < N; start++) {
    if (seen[start] || out[start * 4 + 3]! < 8) continue;
    island.length = 0;
    seen[start] = 1;
    queue[0] = start;
    tail = 1;
    let far = 0;
    for (let head = 0; head < tail; head++) {
      const p = queue[head]!;
      if (island.length <= speck) {
        island.push(p);
        far += Math.hypot(o[p * 4]! - bg[0]!, o[p * 4 + 1]! - bg[1]!, o[p * 4 + 2]! - bg[2]!);
      }
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= N || seen[q] || out[q * 4 + 3]! < 8) continue;
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
    if (tail <= speck && far / tail < 90) for (const p of island) out[p * 4 + 3] = 0;
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/** How flat the picture turned out to be; logged, and what the refusal rests on. */
export interface SharpenStats {
  /** Share of the motif in flat areas. */
  flat: number;
  /** Share of the motif within reach of one of the colours. */
  matched: number;
  /** Mean distance of the flat areas to their colour. */
  error: number;
  /** The same for the one colour that fits worst: see MAX_SPREAD. */
  spread: number;
}

export type SharpenResult =
  | { ok: true; png: Buffer; svg: string; colors: string[]; stats: SharpenStats }
  | { ok: false; reason: "photo" | "empty"; stats?: SharpenStats };

/**
 * A flat logo redrawn as shapes and rendered `longSidePx` on its long side,
 * on the same canvas as the input (same aspect, nothing trimmed), so it
 * can take the place of the picture it came from.
 *
 * Whatever the input shows is kept: a background left on is traced as a
 * colour of its own. The colours are a k-means of the logo's flat areas;
 * the anti-aliased rims between them get the colour of the nearest area,
 * so a dark logo on white grows no grey outline. Each colour becomes a
 * layer covering itself and every colour above it, so the layers meet
 * without gaps however potrace rounds them.
 */
export async function sharpenLogo(
  png: Buffer,
  longSidePx: number,
  judgeAtPx = MAX_TRACE,
): Promise<SharpenResult> {
  const verdict = await judge(png, judgeAtPx);
  if (!verdict.ok) return verdict;
  const { centres, stats } = verdict;
  // A small file (the ones that need this most) is drawn up smoothly first,
  // so its edges fall between its pixels instead of on their steps.
  const { data, W, H } = await rgba(png, MAX_TRACE, MIN_TRACE);
  const N = W * H;
  const K = centres.length;
  const alpha = (p: number) => data[p * 4 + 3]!;
  const nearest = nearestColor(data, centres);

  // Pixels close to a colour take it; the blends between colours (and
  // against a background removed from white) take the colour of the
  // nearest pixel that has one.
  const label = new Int8Array(N).fill(-1);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < N; p++) {
    if (alpha(p) < SOLID) continue;
    const [c, d] = nearest(p);
    if (d <= 28 * 28) {
      label[p] = c;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      if (q < 0 || q >= N || label[q] !== -1 || alpha(q) < SOLID) continue;
      label[q] = label[p]!;
      queue[tail++] = q;
    }
  }
  for (let p = 0; p < N; p++) if (label[p] === -1 && alpha(p) >= SOLID) label[p] = nearest(p)[0];
  majority(label, W, H, K);
  majority(label, W, H, K);

  // Largest colour at the bottom.
  const area = new Array(K).fill(0);
  for (let p = 0; p < N; p++) if (label[p]! >= 0) area[label[p]!]++;
  const order = [...Array(K).keys()].sort((a, b) => area[b] - area[a]);
  const rank = new Int8Array(K);
  order.forEach((c, r) => (rank[c] = r));

  const dir = await mkdtemp(join(tmpdir(), "logo-trace-"));
  try {
    const turd = String(Math.max(4, Math.round(N / 250_000)));
    const layers: string[] = [];
    const colors: string[] = [];
    for (let r = 0; r < K; r++) {
      const hex = toHex(centres[order[r]!]!);
      const pgm = Buffer.alloc(N, 255);
      let any = false;
      for (let p = 0; p < N; p++) {
        if (label[p]! >= 0 && rank[label[p]!]! >= r) {
          pgm[p] = 0;
          any = true;
        }
      }
      if (!any) continue;
      const input = join(dir, `layer${r}.pgm`);
      const output = join(dir, `layer${r}.svg`);
      await writeFile(input, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), pgm]));
      await run("potrace", [input, "-s", "-o", output, "-t", turd, "-a", "1", "-O", "0.4", "--flat", "-C", hex], {
        timeout: 30_000,
      });
      const traced = await readFile(output, "utf8");
      const group = /<g[\s\S]*<\/g>/.exec(traced)?.[0];
      if (group) {
        layers.push(group);
        colors.push(hex);
      }
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
      layers.join("\n") +
      "\n</svg>\n";
    const { Resvg } = await import("@resvg/resvg-js");
    const fit = W >= H ? { mode: "width" as const, value: longSidePx } : { mode: "height" as const, value: longSidePx };
    const rendered = Buffer.from(new Resvg(svg, { fitTo: fit, background: "rgba(0,0,0,0)" }).render().asPng());
    return { ok: true, png: rendered, svg, colors, stats };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type Rgb = number[];

/**
 * Longest side to judge a picture inside a PDF, EPS or AI at. Rendered for
 * print, a small picture is drawn large (the 374 px JPEG inside #1153's
 * PDF) and every pixel becomes a flat block, so a painting looked flat.
 * Uploaded pictures are judged at their own size, as calibrated.
 */
export const JUDGE_EMBEDDED_PX = 800;

/** RGBA pixels at most `longSide` px on the long side, and at least `minLong` (drawn up smoothly). */
async function rgba(png: Buffer, longSide: number, minLong = 0) {
  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const long = Math.max(meta.width || 1, meta.height || 1);
  const target = long < minLong ? Math.min(minLong, long * 4) : Math.min(long, longSide);
  const { data, info } = await sharp(png, { limitInputPixels: false })
    .ensureAlpha()
    .resize({ width: target, height: target, fit: "inside", kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/**
 * Each solid pixel takes the colour most of its 3 × 3 neighbourhood has,
 * in place: JPEG specks and stray rim pixels along an edge go, lines two
 * pixels wide or more stay.
 */
function majority(label: Int8Array, W: number, H: number, K: number) {
  const src = label.slice();
  const counts = new Int32Array(K);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const own = src[p]!;
      if (own < 0) continue;
      counts.fill(0);
      for (let dy = -W; dy <= W; dy += W) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = src[p + dy + dx]!;
          if (c >= 0) counts[c]!++;
        }
      }
      let best = own;
      for (let c = 0; c < K; c++) if (counts[c]! > counts[best]!) best = c;
      label[p] = best;
    }
  }
}

/** The nearest of `centres` to pixel p, and its squared distance. */
function nearestColor(data: Buffer, centres: Rgb[]) {
  return (p: number): [number, number] => {
    const i = p * 4;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const r = data[i]! - centres[c]![0]!;
      const g = data[i + 1]! - centres[c]![1]!;
      const b = data[i + 2]! - centres[c]![2]!;
      const d = r * r + g * g + b * b;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return [best, bestD];
  };
}

type Judgement =
  | { ok: true; centres: Rgb[]; stats: SharpenStats }
  | { ok: false; reason: "photo" | "empty"; stats?: SharpenStats };

/**
 * How many times a picture was drawn larger by repeating its pixels, or 1.
 * Such a picture has hardly a pixel unlike both neighbours in its row:
 * every run of one colour is at least as long as the factor. A file drawn
 * at its own size, even a flat logo, has single pixels along every edge.
 */
function blockFactor(data: Buffer, W: number, H: number): number {
  let runs = 0;
  let singles = 0;
  const lengths = new Array(17).fill(0);
  for (let y = 0; y < H; y += 4) {
    let run = 1;
    for (let x = 1; x <= W; x++) {
      const p = (y * W + x) * 4;
      const same =
        x < W &&
        data[p] === data[p - 4] &&
        data[p + 1] === data[p - 3] &&
        data[p + 2] === data[p - 2] &&
        data[p + 3] === data[p - 1];
      if (same) {
        run++;
        continue;
      }
      runs++;
      if (run === 1) singles++;
      if (run <= 16) lengths[run]++;
      run = 1;
    }
  }
  if (runs < 1000 || singles / runs > 0.05) return 1;
  let factor = 2;
  for (let k = 3; k <= 16; k++) if (lengths[k] > lengths[factor]) factor = k;
  return factor;
}

/** Whether the picture is a flat logo, and its colours; at most `longSide` px. */
async function judge(png: Buffer, longSide: number): Promise<Judgement> {
  let { data, W, H } = await rgba(png, longSide);
  // A small picture blown up pixel by pixel (#1153's cat, saved before
  // pictures in PDFs were drawn smooth) looks flat in blocks: judge it at
  // the size it really has.
  const factor = blockFactor(data, W, H);
  if (factor > 1) ({ data, W, H } = await rgba(png, Math.round(Math.max(W, H) / factor)));
  const N = W * H;
  const alpha = (p: number) => data[p * 4 + 3]!;
  const dist2 = (p: number, q: number) => {
    const i = p * 4;
    const j = q * 4;
    const r = data[i]! - data[j]!;
    const g = data[i + 1]! - data[j + 1]!;
    const b = data[i + 2]! - data[j + 2]!;
    return r * r + g * g + b * b;
  };

  // A background left on is traced like any colour, but whether the motif
  // is flat is judged without it: the white around a painting (#1153) made
  // most of the picture flat and hid the painting's error.
  let clear = 0;
  for (let p = 0; p < N; p++) if (alpha(p) < 8) clear++;
  let frame: Buffer | null = null;
  if (clear < N * 0.02) {
    const cleared = await removeBackground(await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
    frame = await sharp(cleared).extractChannel(3).raw().toBuffer();
  }
  const inMotif = (p: number) => alpha(p) >= SOLID && (!frame || frame[p]! >= SOLID);

  let solid = 0;
  for (let p = 0; p < N; p++) if (inMotif(p)) solid++;
  if (solid < N * 0.001) return { ok: false, reason: "empty" };

  // Flat areas: opaque pixels whose four neighbours are nearly the same colour.
  const interior: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (alpha(p) < 250 || !inMotif(p)) continue;
      let flat = true;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (alpha(q) < 250 || dist2(p, q) > 30 * 30) {
          flat = false;
          break;
        }
      }
      if (flat) interior.push(p);
    }
  }
  // A drawing of thin lines has hardly any flat area; take every solid pixel.
  let samplePixels = interior;
  if (interior.length < solid * 0.2) {
    samplePixels = [];
    for (let p = 0; p < N; p++) if (inMotif(p)) samplePixels.push(p);
  }
  const stride = Math.max(1, Math.floor(samplePixels.length / 120_000));
  const samples: Rgb[] = [];
  for (let k = 0; k < samplePixels.length; k += stride) {
    const i = samplePixels[k]! * 4;
    samples.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }

  const fit = chooseColors(samples);
  const nearest = nearestColor(data, fit.centres);
  let matched = 0;
  for (let p = 0; p < N; p++) if (inMotif(p) && nearest(p)[1] <= 28 * 28) matched++;
  const stats: SharpenStats = {
    flat: interior.length / solid,
    matched: matched / solid,
    error: fit.error,
    spread: widestColor(samples, fit.centres),
  };
  // Calibrated on 45 uploads from October 2026 and #1151/#1153: logos
  // traced cleanly up to an error of 9, while a photo, glitter, a painting
  // or a shaded illustration (posterised by tracing) came out above 9.5,
  // or with little flat area for its error, or with much of it far from
  // every colour. MAX_SPREAD catches what is shaded in only part of the motif.
  if (
    !fit.flat ||
    stats.error > 9.5 ||
    (stats.flat < 0.7 && stats.error > 5) ||
    stats.matched < 0.85 ||
    stats.spread > MAX_SPREAD
  ) {
    return { ok: false, reason: "photo", stats };
  }

  const centres = fit.centres.slice();
  if (frame) {
    // The background's own colour, so it is traced as it is.
    const sum = [0, 0, 0];
    let n = 0;
    for (let p = 0; p < N; p++) {
      if (alpha(p) < SOLID || frame[p]! >= SOLID) continue;
      sum[0]! += data[p * 4]!;
      sum[1]! += data[p * 4 + 1]!;
      sum[2]! += data[p * 4 + 2]!;
      n++;
    }
    const color = [sum[0]! / n, sum[1]! / n, sum[2]! / n];
    // White around a logo with white in it is one colour, not two whites
    // whose JPEG noise traces as faint lines.
    if (n > 0 && !centres.some((c) => Math.hypot(c[0]! - color[0]!, c[1]! - color[1]!, c[2]! - color[2]!) < 25)) {
      centres.push(color);
    }
  }
  return { ok: true, centres, stats };
}

function toHex(c: Rgb): string {
  return "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * The largest mean distance of samples to the colour they are closest to,
 * over the colours that cover at least 3 % of them (see MAX_SPREAD).
 */
function widestColor(samples: Rgb[], centres: Rgb[]): number {
  const sum = new Float64Array(centres.length);
  const count = new Float64Array(centres.length);
  for (const s of samples) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const d = Math.hypot(s[0]! - centres[c]![0]!, s[1]! - centres[c]![1]!, s[2]! - centres[c]![2]!);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    sum[best]! += bestD;
    count[best]!++;
  }
  let widest = 0;
  for (let c = 0; c < centres.length; c++) {
    if (count[c]! >= samples.length * 0.03) widest = Math.max(widest, sum[c]! / count[c]!);
  }
  return widest;
}

/**
 * The fewest colours (up to MAX_COLORS) the flat areas are made of. Not
 * flat when even MAX_COLORS leave a large error: a photo or a gradient.
 */
function chooseColors(samples: Rgb[]): { centres: Rgb[]; flat: boolean; error: number } {
  let last = { centres: [] as Rgb[], flat: false, error: Infinity };
  for (let k = 1; k <= MAX_COLORS; k++) {
    const centres = kMeans(samples, k);
    const assigned = new Array(centres.length).fill(0);
    let sum = 0;
    let close = 0;
    for (const s of samples) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = Math.hypot(s[0]! - centres[c]![0]!, s[1]! - centres[c]![1]!, s[2]! - centres[c]![2]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assigned[best]++;
      sum += bestD;
      if (bestD <= 36) close++;
    }
    // A colour hardly used is noise (a JPEG speck, a blend): left out.
    const kept = centres.filter((_, c) => assigned[c] >= samples.length * 0.003);
    last = { centres: kept.length > 0 ? kept : centres, flat: false, error: sum / samples.length };
    if (last.error <= 12 && close >= samples.length * 0.96) return { ...last, flat: true };
  }
  return last;
}

/** k-means++ with a fixed seed, so the same file gives the same colours. */
function kMeans(samples: Rgb[], k: number): Rgb[] {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const d2 = (a: Rgb, b: Rgb) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

  const centres: Rgb[] = [samples[Math.floor(random() * samples.length)]!.slice()];
  const closest = samples.map((s) => d2(s, centres[0]!));
  while (centres.length < k) {
    const total = closest.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let pick = random() * total;
    let idx = 0;
    for (; idx < samples.length - 1; idx++) {
      pick -= closest[idx]!;
      if (pick <= 0) break;
    }
    centres.push(samples[idx]!.slice());
    for (let i = 0; i < samples.length; i++) closest[i] = Math.min(closest[i]!, d2(samples[i]!, centres[centres.length - 1]!));
  }

  const assign = new Int32Array(samples.length);
  for (let iter = 0; iter < 25; iter++) {
    let moved = false;
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(samples[i]!, centres[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    const sums = new Float64Array(centres.length * 4);
    for (let i = 0; i < samples.length; i++) {
      const o = assign[i]! * 4;
      sums[o] += samples[i]![0]!;
      sums[o + 1] += samples[i]![1]!;
      sums[o + 2] += samples[i]![2]!;
      sums[o + 3] += 1;
    }
    for (let c = 0; c < centres.length; c++) {
      const n = sums[c * 4 + 3]!;
      if (n > 0) centres[c] = [sums[c * 4]! / n, sums[c * 4 + 1]! / n, sums[c * 4 + 2]! / n];
    }
    if (!moved && iter > 0) break;
  }
  return centres;
}

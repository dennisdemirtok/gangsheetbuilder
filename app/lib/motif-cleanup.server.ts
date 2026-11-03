import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { convertToRaster, embedsPictures, needsGhostscript, removeBackground, trimTransparentEdges } from "./image-processing.server";

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
/** At most this many colours; a logo with more is not flat. */
const MAX_COLORS = 8;

/**
 * The motif as a PNG to work on: PDF, EPS and AI through Ghostscript, SVG
 * through resvg (the server's libvips cannot read SVG), anything else as
 * it is. `dpi` applies to the vector formats.
 */
export async function motifRaster(buffer: Buffer, filename: string, dpi = 300): Promise<Buffer> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (needsGhostscript(filename)) return convertToRaster(buffer, filename, dpi);
  if (ext === "svg") {
    const { Resvg } = await import("@resvg/resvg-js");
    const svg = new Resvg(buffer, { dpi, fitTo: { mode: "zoom", value: dpi / 96 }, background: "rgba(0,0,0,0)" });
    return Buffer.from(svg.render().asPng());
  }
  return sharp(buffer, { limitInputPixels: false, animated: false }).rotate().png().toBuffer();
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
  | { ok: true; png: Buffer }
  | { ok: false; reason: "transparent" | "no_background" };

/**
 * The background around the motif made transparent and the empty margin
 * cut away. Refused when the file is already transparent, or when no one
 * colour frames it (a photo to its edges), since nothing would change.
 */
export async function removeMotifBackground(png: Buffer): Promise<BackgroundResult> {
  if (await isTransparent(png)) return { ok: false, reason: "transparent" };
  const cleared = await removeBackground(png);
  if (!(await isTransparent(cleared))) return { ok: false, reason: "no_background" };
  const trimmed = await trimTransparentEdges(cleared);
  return { ok: true, png: trimmed.buffer };
}

/** How flat the picture turned out to be; logged, and what the refusal rests on. */
export interface SharpenStats {
  /** Share of the motif in flat areas. */
  flat: number;
  /** Share of the motif within reach of one of the colours. */
  matched: number;
  /** Mean distance of the flat areas to their colour. */
  error: number;
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
export async function sharpenLogo(png: Buffer, longSidePx: number, judgeAtPx = MAX_TRACE): Promise<SharpenResult> {
  const verdict = await judge(png, judgeAtPx);
  if (!verdict.ok) return verdict;
  const { centres, stats } = verdict;
  const { data, W, H } = await rgba(png, MAX_TRACE);
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

async function rgba(png: Buffer, longSide: number) {
  const { data, info } = await sharp(png, { limitInputPixels: false })
    .ensureAlpha()
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
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

/** Whether the picture is a flat logo, and its colours; at most `longSide` px. */
async function judge(png: Buffer, longSide: number): Promise<Judgement> {
  const { data, W, H } = await rgba(png, longSide);
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
  const stats: SharpenStats = { flat: interior.length / solid, matched: matched / solid, error: fit.error };
  // Calibrated on 45 uploads from October 2026 and #1151/#1153: logos
  // traced cleanly up to an error of 9, while a photo, glitter, a painting
  // or a shaded illustration (posterised by tracing) came out above 9.5,
  // or with little flat area for its error, or with much of it far from
  // every colour.
  if (!fit.flat || stats.error > 9.5 || (stats.flat < 0.7 && stats.error > 5) || stats.matched < 0.85) {
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
    if (n > 0) centres.push([sum[0]! / n, sum[1]! / n, sum[2]! / n]);
  }
  return { ok: true, centres, stats };
}

function toHex(c: Rgb): string {
  return "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
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

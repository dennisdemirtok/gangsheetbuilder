import { fontById, fontFamily, loadFont } from "../config/fonts";

/**
 * Text drawn into a PNG for the sheet.
 *
 * Text was drawn at its font size in pixels — 48 px — and placed as if
 * that were 300 DPI, so a word came out about 3 cm wide and turned soft
 * the moment it was made bigger. It is now drawn for the width it will
 * print at, at 300 DPI, measured from the ink itself so script fonts that
 * swing past their letter boxes are not cut off.
 */

export interface TextSpec {
  text: string;
  fontId: string;
  color: string;
  /** Outline around the letters as a share of the font size; 0 is none. */
  outline: number;
  outlineColor: string;
  align: "left" | "center" | "right";
}

/** A text design as added to the sheet, kept so it can be edited later. */
export interface TextDesign extends TextSpec {
  widthMm: number;
}

/** Glyphs are measured at this size and everything is scaled from it. */
const REF = 200;

/** Safe for iOS Safari, which drops canvases above ~16.7 million pixels. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 12_000;

interface Laid {
  lines: { text: string; x: number; y: number }[];
  /** Ink box at REF size, outline included. */
  minX: number;
  minY: number;
  w: number;
  h: number;
  outline: number;
  family: string;
}

async function layout(spec: TextSpec): Promise<Laid | null> {
  const font = fontById(spec.fontId);
  await loadFont(font);
  const family = fontFamily(font);

  const raw = spec.text.replace(/\r/g, "").split("\n");
  while (raw.length > 0 && !raw[0]!.trim()) raw.shift();
  while (raw.length > 0 && !raw[raw.length - 1]!.trim()) raw.pop();
  if (raw.length === 0) return null;

  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  probe.font = `400 ${REF}px "${family}"`;

  const step = REF * (font.lineHeight ?? 1.15);
  const outline = Math.max(0, spec.outline) * REF;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const lines: Laid["lines"] = [];

  raw.forEach((text, i) => {
    if (!text.trim()) return;
    const m = probe.measureText(text);
    const left = m.actualBoundingBoxLeft;
    const right = m.actualBoundingBoxRight;
    const inkW = left + right;
    // Lines line up by their ink, not their advance width.
    const x = spec.align === "left" ? left : spec.align === "right" ? -right : left - inkW / 2;
    const y = i * step;
    lines.push({ text, x, y });
    minX = Math.min(minX, x - left);
    maxX = Math.max(maxX, x + right);
    minY = Math.min(minY, y - m.actualBoundingBoxAscent);
    maxY = Math.max(maxY, y + m.actualBoundingBoxDescent);
  });

  if (lines.length === 0 || maxX <= minX || maxY <= minY) return null;
  return {
    lines,
    minX: minX - outline,
    minY: minY - outline,
    w: maxX - minX + outline * 2,
    h: maxY - minY + outline * 2,
    outline,
    family,
  };
}

function draw(laid: Laid, spec: TextSpec, scale: number): HTMLCanvasElement | null {
  const pad = Math.max(2, Math.ceil(REF * scale * 0.03));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(laid.w * scale) + pad * 2;
  canvas.height = Math.ceil(laid.h * scale) + pad * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Drawn at the final size, not scaled up, so edges stay vector-sharp.
  ctx.font = `400 ${REF * scale}px "${laid.family}"`;
  ctx.textBaseline = "alphabetic";
  const at = (l: Laid["lines"][number]): [number, number] => [
    pad + (l.x - laid.minX) * scale,
    pad + (l.y - laid.minY) * scale,
  ];

  // Every outline first, then every fill: on text with several lines a
  // later line's outline must not cover the line above.
  if (laid.outline > 0) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = laid.outline * 2 * scale;
    ctx.strokeStyle = spec.outlineColor;
    for (const l of laid.lines) ctx.strokeText(l.text, ...at(l));
  }
  ctx.fillStyle = spec.color;
  for (const l of laid.lines) ctx.fillText(l.text, ...at(l));
  return canvas;
}

/**
 * Text for print: `widthMm` wide at 300 DPI (less only for very large
 * text, where the browser's canvas limit is reached). `mmPerPx` turns the
 * uploaded PNG's pixels back into millimetres — the server trims the
 * transparent padding, so the PNG it reports is a few pixels smaller.
 */
export async function renderTextForPrint(
  spec: TextSpec,
  widthMm: number,
): Promise<{ canvas: HTMLCanvasElement; mmPerPx: number; heightMm: number } | null> {
  const laid = await layout(spec);
  if (!laid) return null;
  const targetPx = (widthMm / 25.4) * 300;
  const scale = Math.min(
    targetPx / laid.w,
    MAX_SIDE / laid.w,
    MAX_SIDE / laid.h,
    Math.sqrt(MAX_PIXELS / (laid.w * laid.h)),
  );
  const canvas = draw(laid, spec, scale);
  if (!canvas) return null;
  const mmPerPx = widthMm / (laid.w * scale);
  return { canvas, mmPerPx, heightMm: laid.h * scale * mmPerPx };
}

/**
 * Text for print by letter height: names and numbers are ordered as "7 cm"
 * or "25 cm" tall. The letters (not the outline around them) are
 * `heightMm` high; the outline adds to the piece. `mmPerPx` as above.
 */
export async function renderTextAtHeight(
  spec: TextSpec,
  heightMm: number,
): Promise<{ canvas: HTMLCanvasElement; mmPerPx: number; widthMm: number; heightMm: number } | null> {
  const laid = await layout(spec);
  if (!laid) return null;
  const letters = Math.max(1, laid.h - laid.outline * 2);
  const targetPx = (heightMm / 25.4) * 300;
  const scale = Math.min(
    targetPx / letters,
    MAX_SIDE / laid.w,
    MAX_SIDE / laid.h,
    Math.sqrt(MAX_PIXELS / (laid.w * laid.h)),
  );
  const canvas = draw(laid, spec, scale);
  if (!canvas) return null;
  const mmPerPx = heightMm / (letters * scale);
  return { canvas, mmPerPx, widthMm: laid.w * scale * mmPerPx, heightMm: laid.h * scale * mmPerPx };
}

/** The printed size of text at a letter height, without drawing it. */
export async function measureTextAtHeight(
  spec: TextSpec,
  heightMm: number,
): Promise<{ widthMm: number; heightMm: number } | null> {
  const laid = await layout(spec);
  if (!laid) return null;
  const mmPerRef = heightMm / Math.max(1, laid.h - laid.outline * 2);
  return { widthMm: laid.w * mmPerRef, heightMm: laid.h * mmPerRef };
}

/** Text for the preview, fitted inside maxW × maxH pixels. */
export async function renderTextPreview(
  spec: TextSpec,
  maxW: number,
  maxH: number,
): Promise<{ canvas: HTMLCanvasElement; aspect: number } | null> {
  const laid = await layout(spec);
  if (!laid) return null;
  const scale = Math.min(maxW / laid.w, maxH / laid.h);
  const canvas = draw(laid, spec, scale);
  return canvas ? { canvas, aspect: laid.h / laid.w } : null;
}

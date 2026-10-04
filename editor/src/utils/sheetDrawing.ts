import type { Placement } from "./packing";

/**
 * A sheet drawn small: the designs where they sit on the film, on the
 * mid-grey checks the builder shows, so white and dark prints both read.
 * The guide's preview, the order summary and the cart's thumbnail all
 * draw it this way, so the sheet looks the same everywhere.
 */

export interface PreviewPiece {
  /** Placed by the packer (new designs) — position and turn. */
  placement?: Placement;
  /** Already on the sheet — bounding box and rotation as placed. */
  fixed?: { x: number; y: number; w: number; h: number; rotation: number; unrotatedW: number; unrotatedH: number };
  url: string;
}

/** Draw the sheet `cw` × `ch` px at `scale` px per mm; missing images show as a tinted box. */
export function drawSheet(
  ctx: CanvasRenderingContext2D,
  pieces: PreviewPiece[],
  images: Map<string, HTMLImageElement>,
  scale: number,
  cw: number,
  ch: number,
  cell: number,
): void {
  for (let y = 0; y < ch; y += cell) {
    for (let x = 0; x < cw; x += cell) {
      ctx.fillStyle = ((x + y) / cell) % 2 === 0 ? "#cdcdcd" : "#b4b4b4";
      ctx.fillRect(x, y, cell, cell);
    }
  }

  for (const piece of pieces) {
    const img = images.get(piece.url);
    const ready = img && img.complete && img.naturalWidth > 0;
    let x: number, y: number, w: number, h: number, rotation: number, uw: number, uh: number;
    if (piece.placement) {
      ({ x, y, w, h } = piece.placement);
      rotation = piece.placement.rotated ? 90 : 0;
      uw = piece.placement.rotated ? h : w;
      uh = piece.placement.rotated ? w : h;
    } else if (piece.fixed) {
      ({ x, y, w, h, rotation } = piece.fixed);
      uw = piece.fixed.unrotatedW;
      uh = piece.fixed.unrotatedH;
    } else continue;

    const cx = (x + w / 2) * scale;
    const cy = (y + h / 2) * scale;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotation * Math.PI) / 180);
    if (ready) {
      ctx.drawImage(img!, (-uw / 2) * scale, (-uh / 2) * scale, uw * scale, uh * scale);
    } else {
      ctx.fillStyle = "rgba(220,47,60,0.25)";
      ctx.fillRect((-uw / 2) * scale, (-uh / 2) * scale, uw * scale, uh * scale);
    }
    ctx.restore();
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * The sheet as a picture for its cart line, at most `maxW` × `maxH` px: a
 * long sheet gets narrower so its whole length shows. Null when it cannot
 * be drawn, for instance when an image comes from another site and the
 * browser will not let the drawing be read back.
 */
export async function renderSheetThumbnail(
  pieces: PreviewPiece[],
  sheetWidthMm: number,
  sheetHeightMm: number,
  maxW = 240,
  maxH = 720,
): Promise<string | null> {
  try {
    const urls = [...new Set(pieces.map((p) => p.url).filter(Boolean))];
    const loaded = await Promise.all(urls.map(loadImage));
    const images = new Map<string, HTMLImageElement>();
    urls.forEach((url, i) => {
      const img = loaded[i];
      if (img) images.set(url, img);
    });

    const scale = Math.min(maxW / sheetWidthMm, maxH / sheetHeightMm);
    const cw = Math.max(1, Math.round(sheetWidthMm * scale));
    const ch = Math.max(1, Math.round(sheetHeightMm * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    drawSheet(ctx, pieces, images, scale, cw, ch, 6);
    return canvas.toDataURL("image/webp", 0.85);
  } catch {
    return null;
  }
}

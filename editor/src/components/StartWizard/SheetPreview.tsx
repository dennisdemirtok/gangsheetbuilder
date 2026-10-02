import { useEffect, useMemo, useRef, useState } from "react";
import type { Placement } from "../../utils/packing";
import { theme } from "../../styles/theme";

/**
 * The sheet as the guide will build it, drawn small while the customer
 * still sets sizes and counts — the same nesting the build runs, so what
 * they see is what they get. Without it the only feedback was a length.
 */

export interface PreviewPiece {
  /** Placed by the packer (new designs) — position and turn. */
  placement?: Placement;
  /** Already on the sheet — bounding box and rotation as placed. */
  fixed?: { x: number; y: number; w: number; h: number; rotation: number; unrotatedW: number; unrotatedH: number };
  url: string;
}

const images = new Map<string, HTMLImageElement>();


export function SheetPreview({
  pieces,
  sheetWidthMm,
  sheetHeightMm,
  label,
}: {
  pieces: PreviewPiece[];
  sheetWidthMm: number;
  sheetHeightMm: number;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const loaded = useMemo(() => () => setTick((t) => t + 1), []);

  // Load every distinct image once.
  const urls = useMemo(() => [...new Set(pieces.map((p) => p.url).filter(Boolean))], [pieces]);
  for (const url of urls) {
    if (!images.has(url)) {
      const el = new Image();
      el.onload = loaded;
      el.src = url;
      images.set(url, el);
    }
  }

  // 180 px wide; long sheets get narrower so the whole length shows.
  const MAX_W = 180;
  const MAX_H = 440;
  const scale = Math.min(MAX_W / sheetWidthMm, MAX_H / sheetHeightMm);
  const cw = Math.max(1, Math.round(sheetWidthMm * scale));
  const ch = Math.max(1, Math.round(sheetHeightMm * scale));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Mid-grey checks, as on the sheet itself.
    const cell = 6;
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
  }, [pieces, cw, ch, scale, tick]);

  return (
    <div style={P.wrap}>
      <span style={P.title}>Så blir arket</span>
      <canvas ref={canvasRef} style={{ width: cw, height: ch, display: "block", boxShadow: theme.shadow }} />
      <span style={P.label}>{label}</span>
    </div>
  );
}

const P: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
    alignSelf: "flex-start",
  },
  label: {
    fontSize: theme.fontSize.labelMd,
    color: theme.textMuted,
  },
};

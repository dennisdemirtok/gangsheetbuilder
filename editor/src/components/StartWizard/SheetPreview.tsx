import { useEffect, useMemo, useRef, useState } from "react";
import { drawSheet, type PreviewPiece } from "../../utils/sheetDrawing";
import { theme } from "../../styles/theme";

/**
 * The sheet as the guide will build it, drawn small while the customer
 * still sets sizes and counts — the same nesting the build runs, so what
 * they see is what they get. Without it the only feedback was a length.
 */

export type { PreviewPiece };

const images = new Map<string, HTMLImageElement>();


export function SheetPreview({
  pieces,
  sheetWidthMm,
  sheetHeightMm,
  label,
  maxWidth = 180,
  maxHeight = 440,
  bare = false,
}: {
  pieces: PreviewPiece[];
  sheetWidthMm: number;
  sheetHeightMm: number;
  label: string;
  /** Fit inside this box (px). */
  maxWidth?: number;
  maxHeight?: number;
  /** Just the sheet: no title or label (thumbnails in the order summary). */
  bare?: boolean;
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

  // Long sheets get narrower so the whole length shows.
  const MAX_W = maxWidth;
  const MAX_H = maxHeight;
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

    drawSheet(ctx, pieces, images, scale, cw, ch, bare ? 4 : 6);
  }, [pieces, cw, ch, scale, tick]);

  const sheet = <canvas ref={canvasRef} aria-label={label} style={{ width: cw, height: ch, display: "block", boxShadow: theme.shadow }} />;
  if (bare) return sheet;
  return (
    <div style={P.wrap}>
      <span style={P.title}>Så blir arket</span>
      {sheet}
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

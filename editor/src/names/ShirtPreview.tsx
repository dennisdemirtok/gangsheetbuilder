import { useEffect, useId, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { DOUBLE_OUTLINE, OUTLINE_WIDTH, styleById, type Look } from "./catalog";

/**
 * The back of a shirt with the first player on it, in the chosen styles,
 * colours and sizes, drawn to scale: a 7 cm name over a 25 cm number looks
 * like it will on the shirt. Swatches change the shirt, not the print.
 */

export const SHIRT_COLORS: { value: string; label: string }[] = [
  { value: "#f4f4f2", label: "Vit" },
  { value: "#1b1b1d", label: "Svart" },
  { value: "#9a9ca0", label: "Grå" },
  { value: "#1d2742", label: "Marinblå" },
  { value: "#b3202a", label: "Röd" },
  { value: "#2f4f9f", label: "Blå" },
  { value: "#2f5d3a", label: "Grön" },
  { value: "#e2b13c", label: "Gul" },
];

// Shirt drawn in a 400 × 460 box; the back is ~52 cm across at the chest.
const UNITS_PER_CM = 210 / 52;

/**
 * How tall capitals or digits are against the font size, measured once per
 * face: Anton's digits are ~0.86 of it, Roboto Condensed's caps ~0.71, and
 * one figure for all put a 25 cm number on top of the name.
 */
const ratios = new Map<string, number>();
function capRatio(family: string, sample: string): number {
  const key = `${family}|${sample}`;
  const known = ratios.get(key);
  if (known) return known;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0.72;
  ctx.font = `100px "${family}"`;
  const m = ctx.measureText(sample);
  const r = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 100;
  const ratio = r > 0.3 && r < 1.2 ? r : 0.72;
  // Remember it only once the face itself is in: fonts.check() also says
  // yes when no face of that name exists yet, and the fallback's figure
  // would stick.
  const loaded = [...document.fonts].some((f) => f.family.replace(/"/g, "") === family && f.status === "loaded");
  if (loaded) ratios.set(key, ratio);
  return ratio;
}

export function ShirtPreview({
  look,
  name,
  number,
  shirt,
}: {
  look: Look;
  name: string;
  number: string;
  shirt: string;
}) {
  const [, setReady] = useState(0);
  const nameFont = fontById(styleById(look.nameStyle).fontId);
  const numberFont = fontById(styleById(look.numberStyle).fontId);
  useEffect(() => {
    let alive = true;
    void Promise.all([loadFont(nameFont), loadFont(numberFont)]).then(() => alive && setReady((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [nameFont, numberFont]);

  const showName = look.setup !== "numbers";
  const showNumber = look.setup !== "names";
  const nameSize = (look.nameCm * UNITS_PER_CM) / capRatio(fontFamily(nameFont), "HANDE");
  const numberSize = (look.numberCm * UNITS_PER_CM) / capRatio(fontFamily(numberFont), "0123456789");
  const nameY = 128 + look.nameCm * UNITS_PER_CM;
  // A hand's width (~4 cm) between name and number, as on a club shirt.
  const numberY = (showName ? nameY + 4 * UNITS_PER_CM : 140) + look.numberCm * UNITS_PER_CM;
  const stroke = look.outline !== "none" ? look.outline : "none";
  const seam = shade(shirt, -0.12);

  return (
    <svg viewBox="0 0 400 460" role="img" aria-label="Förhandsvisning på tröja" style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="nn-fold" x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.06" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.07" />
        </linearGradient>
      </defs>
      <path
        d="M140 38 C160 52 240 52 260 38 L330 62 L392 140 L345 178 L305 150 L305 432 C250 442 150 442 95 432 L95 150 L55 178 L8 140 L70 62 Z"
        fill={shirt}
        stroke={seam}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M140 38 C160 52 240 52 260 38" fill="none" stroke={seam} strokeWidth="3" />
      <path d="M95 150 L95 432 C150 442 250 442 305 432 L305 150" fill="url(#nn-fold)" />
      {showName && (
        <Lettering
          y={nameY}
          family={fontFamily(nameFont)}
          size={nameSize}
          fill={look.color}
          stroke={stroke}
          double={styleById(look.nameStyle).outline === "double"}
          letterSpacing="0.02em"
          text={(look.uppercase ? name.toLocaleUpperCase("sv-SE") : name) || "NAMN"}
        />
      )}
      {showNumber && (
        <Lettering
          y={numberY}
          family={fontFamily(numberFont)}
          size={numberSize}
          fill={look.color}
          stroke={stroke}
          double={styleById(look.numberStyle).outline === "double"}
          width={styleById(look.numberStyle).outlineWidth}
          text={number || "10"}
        />
      )}
    </svg>
  );
}

/**
 * A name or number on the shirt, outlined as it prints: no outline, a
 * single line, or the double outline (line, gap, line inside the figure).
 */
function Lettering({
  y,
  family,
  size,
  fill,
  stroke,
  double,
  width,
  letterSpacing,
  text,
}: {
  y: number;
  family: string;
  size: number;
  fill: string;
  stroke: string;
  double: boolean;
  /** Single outline thickness, when not the usual. */
  width?: number;
  letterSpacing?: string;
  text: string;
}) {
  const clip = `nn-inline-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const common = {
    x: 200,
    y,
    textAnchor: "middle" as const,
    fontFamily: `"${family}", sans-serif`,
    fontSize: size,
    style: letterSpacing ? { letterSpacing } : undefined,
  };
  if (stroke === "none") return <text {...common} fill={fill}>{text}</text>;
  if (!double) {
    return (
      <text {...common} fill={fill} stroke={stroke} strokeWidth={size * (width ?? OUTLINE_WIDTH) * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
    );
  }
  const { outer, gap, inner } = DOUBLE_OUTLINE;
  return (
    <g>
      <text {...common} fill={fill} stroke={stroke} strokeWidth={size * (outer + gap) * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
      <text {...common} fill={fill} stroke={fill} strokeWidth={size * gap * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
      <clipPath id={clip}>
        <text {...common}>{text}</text>
      </clipPath>
      <text {...common} fill="none" stroke={stroke} strokeWidth={size * inner * 2} strokeLinejoin="round" clipPath={`url(#${clip})`}>
        {text}
      </text>
    </g>
  );
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + 255 * amount)));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

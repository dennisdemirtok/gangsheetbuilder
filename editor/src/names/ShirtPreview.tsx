import { useEffect, useId, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { MIN_LINE_MM } from "../utils/textRender";
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
/** The thinnest outline line, as in print. */
const MIN_LINE = (MIN_LINE_MM / 10) * UNITS_PER_CM;

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
  // A line of the outline, never thinner than it prints.
  const line = (share: number) => Math.max(size * share, MIN_LINE);
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
      <text {...common} fill={fill} stroke={stroke} strokeWidth={line(width ?? OUTLINE_WIDTH) * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
    );
  }
  const { outer, gap, inner } = DOUBLE_OUTLINE;
  return (
    <g>
      <text {...common} fill={fill} stroke={stroke} strokeWidth={(line(outer) + line(gap)) * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
      <text {...common} fill={fill} stroke={fill} strokeWidth={line(gap) * 2} strokeLinejoin="round" paintOrder="stroke">
        {text}
      </text>
      <clipPath id={clip}>
        <text {...common}>{text}</text>
      </clipPath>
      <text {...common} fill="none" stroke={stroke} strokeWidth={line(inner) * 2} strokeLinejoin="round" clipPath={`url(#${clip})`}>
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

/** How wide `text` prints at a figure height, from the font itself. */
export function textWidthCm(family: string, text: string, heightCm: number, sample = "0123456789"): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * heightCm * 0.55;
  ctx.font = `100px "${family}"`;
  const m = ctx.measureText(text);
  const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width;
  return (w / (capRatio(family, sample) * 100)) * heightCm;
}

/**
 * The packshots are ghost-mannequin shots: the body is round, so its
 * visible width says little, but collar to hem is the size chart's length
 * on 98 % of the picture's height. That length sets the scale, as on the
 * team page, so a 25 cm number on 110/120 takes the room it will.
 */
const PACK = {
  w: 760,
  h: 1000,
  collar: 12,
  length: 0.98,
  /** Centre of the club logo across the picture (the wearer's left chest). */
  logoX: 0.645,
};

export interface PreviewLogo {
  src: string | null;
  widthCm: number;
  place: "back" | "chest" | "sleeve";
}

/**
 * Back and front of the shirt with the chosen row on it: the name over
 * the number on the back, initials under the club logo on the front, and
 * the sponsors where they go. On the shirt's own packshots when it has
 * them; a flat shirt is drawn when not.
 */
export function PackshotPreview({
  front,
  back,
  shirtColor,
  chart,
  ink,
  name,
  number,
  initials,
  nameFamily,
  numberFamily,
  nameCm,
  numberCm,
  initialsCm,
  sponsors,
}: {
  front: string | null;
  back: string | null;
  shirtColor: string;
  /** Half chest and body length of the size shown, cm. */
  chart: { chest: number; length: number };
  ink: string;
  name: string | null;
  number: string | null;
  initials: string | null;
  nameFamily: string;
  numberFamily: string;
  nameCm: number;
  numberCm: number;
  initialsCm: number;
  sponsors: PreviewLogo[];
}) {
  const photos = Boolean(front && back);
  const W = photos ? PACK.w : 400;
  const top = photos ? PACK.collar : 34;
  const u = photos ? (PACK.h * PACK.length) / chart.length : 220 / chart.chest;
  const L = chart.length * u;
  const hem = top + L;
  const viewH = photos ? PACK.h : Math.ceil(hem + 8);
  const cx = W / 2;

  const stroke = shade(shirtColor, -0.14);
  const body = `M152,${top} C170,${top + 14} 230,${top + 14} 248,${top} L330,${top + 26} L384,${top + 98} L336,${top + 126} L310,${top + 102} L310,${hem} L90,${hem} L90,${top + 102} L64,${top + 126} L16,${top + 98} L70,${top + 26} Z`;
  const drawn = (side: "back" | "front") => (
    <>
      <path d={body} fill={shirtColor} stroke={stroke} strokeWidth={2} />
      <path d={`M152,${top} C170,${top + (side === "back" ? 10 : 40)} 230,${top + (side === "back" ? 10 : 40)} 248,${top}`} fill={side === "back" ? "none" : "rgba(0,0,0,0.12)"} stroke={stroke} strokeWidth={side === "back" ? 3 : 2} />
    </>
  );

  const line = photos ? 3 : 1;
  const box = (sp: PreviewLogo, x: number, y: number, transform?: string) => {
    const w = sp.widthCm * u;
    const h = w * 0.4;
    return sp.src ? (
      <image href={sp.src} x={x - w / 2} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" transform={transform} />
    ) : (
      <g transform={transform}>
        <rect x={x - w / 2} y={y} width={w} height={h} rx={3} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={line} opacity={0.8} />
        <text x={x} y={y + h / 2 + h * 0.15} textAnchor="middle" fontSize={Math.min(photos ? 30 : 12, h * 0.45)} fill={ink} opacity={0.85} fontFamily="inherit">
          SPONSOR
        </text>
      </g>
    );
  };
  const backSponsor = sponsors.find((s) => s.place === "back");
  const chest = sponsors.find((s) => s.place === "chest");
  const sleeve = sponsors.find((s) => s.place === "sleeve");

  // Back, top down: sponsor, name, a hand's width (~3 cm), number.
  const sponsorTop = top + 0.08 * L;
  let y = backSponsor ? sponsorTop + backSponsor.widthCm * u * 0.4 + 2 * u : top + 0.11 * L;
  const nameBase = y + nameCm * u;
  if (name) y = nameBase + 3 * u;
  else y = Math.max(y, top + 0.19 * L);
  const numberBase = y + numberCm * u;

  // Front: the club logo (a placeholder) on the left chest, initials under it.
  const logoCm = 7;
  const logoTop = top + 0.2 * L;
  const logoX = photos ? W * PACK.logoX : 255;
  const initialsBase = logoTop + logoCm * u + 1.5 * u + initialsCm * u;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      <figure style={{ margin: 0, textAlign: "center" }}>
        <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans baksida">
          {photos ? <image href={back!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("back")}
          {backSponsor && box(backSponsor, cx, sponsorTop)}
          {name && (
            <text x={cx} y={nameBase} textAnchor="middle" fontSize={(nameCm * u) / capRatio(nameFamily, "HANDE")} fill={ink} fontFamily={`"${nameFamily}", sans-serif`} style={{ letterSpacing: "0.02em" }}>
              {name}
            </text>
          )}
          {number && (
            <text x={cx} y={numberBase} textAnchor="middle" fontSize={(numberCm * u) / capRatio(numberFamily, "0123456789")} fill={ink} fontFamily={`"${numberFamily}", sans-serif`}>
              {number}
            </text>
          )}
        </svg>
        <figcaption style={{ fontSize: 12.5, color: "#6b6b70" }}>Bak</figcaption>
      </figure>
      <figure style={{ margin: 0, textAlign: "center" }}>
        <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans framsida">
          {photos ? <image href={front!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("front")}
          {initials && (
            <>
              <circle cx={logoX} cy={logoTop + (logoCm * u) / 2} r={(logoCm * u) / 2} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={line} opacity={0.6} />
              <text x={logoX} y={logoTop + (logoCm * u) / 2 + 2.2 * u * 0.35} textAnchor="middle" fontSize={2.2 * u} fill={ink} opacity={0.6} fontFamily="inherit">
                LOGGA
              </text>
              <text x={logoX} y={initialsBase} textAnchor="middle" fontSize={(initialsCm * u) / capRatio(nameFamily, "HANDE")} fill={ink} fontFamily={`"${nameFamily}", sans-serif`}>
                {initials}
              </text>
            </>
          )}
          {chest && box(chest, cx, top + 0.36 * L)}
          {sleeve && (photos ? box(sleeve, W * 0.1, PACK.h * 0.2, `rotate(-62 ${W * 0.1} ${PACK.h * 0.22})`) : box(sleeve, 52, top + 64, `rotate(-52 52 ${top + 70})`))}
        </svg>
        <figcaption style={{ fontSize: 12.5, color: "#6b6b70" }}>Fram</figcaption>
      </figure>
    </div>
  );
}

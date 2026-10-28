import { useEffect, useId, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { MIN_LINE_MM } from "../utils/textRender";
import { DOUBLE_OUTLINE, OUTLINE_WIDTH, styleById, type Look } from "./catalog";
import { FittedImage, PACK, Shot, Zoom, useAspect } from "../team/TeamBuilder";

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
 * How wide a print on the back may be: the back panel at the shoulder
 * blades, inside the sleeve seams and a margin, as a share of the flat
 * chest width. 33 cm on 130/140.
 */
export const BACK_PRINT_SHARE = 0.85;
export const backRoomCm = (chart: { chest: number }) => chart.chest * BACK_PRINT_SHARE;

/** Each character's advance in cm at a cap height, as the print sets them (no extra spacing). */
function advancesCm(family: string, text: string, heightCm: number, sample: string) {
  const fontCm = heightCm / capRatio(family, sample);
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = `100px "${family}"`;
  const widths = [...text].map((ch) => (ctx ? (ctx.measureText(ch).width / 100) * fontCm : fontCm * 0.55));
  return { widths, fontCm };
}

export interface PreviewLogo {
  src: string | null;
  widthCm: number;
  place: "back" | "chest" | "sleeve";
}

/**
 * Back and front of the shirt with the chosen row on it: the name over
 * the number on the back, initials under the club logo on the front, and
 * the sponsors where they go. A click shows it large, and another zooms in.
 *
 * The packshots are placed and scaled as on the team page (its PACK and
 * Shot: the shop's 4:5 product images or New Wave's own). They are of a
 * round form whose back shows as wide as its diameter (chest × 2 / π:
 * 25 cm on 130/140, whose flat width is 39 cm), so lettering is placed by
 * its distance along the fabric and narrowed where the body turns away;
 * logos keep their own proportions and are only placed that way. Without
 * packshots a flat shirt is drawn, and nothing wraps.
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
  size,
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
  /** The size shown, for the caption. */
  size: string;
}) {
  const [zoomed, setZoomed] = useState<"back" | "front" | null>(null);
  const photos = Boolean(front && back);
  const W = photos ? PACK.w : 400;
  const top = photos ? PACK.shotTop + PACK.collar * PACK.shotHeight : 34;
  const u = photos ? (PACK.shotHeight * PACK.length) / chart.length : 220 / chart.chest;
  const L = chart.length * u;
  const hem = top + L;
  const viewH = photos ? PACK.h : Math.ceil(hem + 8);
  const cx = W / 2;

  // Along the fabric (cm from the middle) to across the picture: the round
  // form's radius is the chest circumference over 2π.
  const R = (2 * chart.chest) / (2 * Math.PI);
  const angle = (xCm: number) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, xCm / R));
  const toX = (xCm: number) => cx + (photos ? R * Math.sin(angle(xCm)) : xCm) * u;
  const squeeze = (xCm: number) => (photos ? Math.cos(angle(xCm)) : 1);
  /** How wide something `widthCm` across, centred on `centreCm`, shows on the body. */
  const shownWidth = (widthCm: number, centreCm: number) =>
    photos ? R * (Math.sin(angle(centreCm + widthCm / 2)) - Math.sin(angle(centreCm - widthCm / 2))) * u : widthCm * u;

  /** Text on the fabric, centred on `centreCm`, its baseline at `baseY`: each character where it falls on the body. */
  const wrapped = (text: string, family: string, hCm: number, sample: string, centreCm: number, baseY: number) => {
    const { widths, fontCm } = advancesCm(family, text, hCm, sample);
    let x = centreCm - widths.reduce((a, b) => a + b, 0) / 2;
    return [...text].map((ch, i) => {
      const mid = x + widths[i]! / 2;
      x += widths[i]!;
      return ch.trim() ? (
        <text
          key={i}
          transform={`translate(${toX(mid)} ${baseY}) scale(${squeeze(mid)} 1)`}
          textAnchor="middle"
          fontSize={fontCm * u}
          fill={ink}
          fontFamily={`"${family}", sans-serif`}
        >
          {ch}
        </text>
      ) : null;
    });
  };

  // A name or number wider than the back is not drawn round the sides:
  // the shirt says it does not fit, and the page says what to change.
  const nameWidth = name ? textWidthCm(nameFamily, name, nameCm, "HANDE") : 0;
  const numberWidth = number ? textWidthCm(numberFamily, number, numberCm) : 0;
  const room = backRoomCm(chart);
  const doesNotFit = (label: string, hCm: number, baseY: number) => {
    const w = shownWidth(room, 0);
    const h = Math.max(hCm, 4) * u;
    const y0 = baseY - hCm * u - (h - hCm * u) / 2;
    return (
      <g>
        <rect x={cx - w / 2} y={y0} width={w} height={h} rx={h * 0.18} fill="#dc2f3c" opacity={0.92} />
        <text x={cx} y={y0 + h / 2} dominantBaseline="central" textAnchor="middle" fill="#fff" fontWeight={700} fontSize={Math.min(h * 0.36, (w * 0.9) / (label.length * 0.56))} style={{ fontFamily: "inherit" }}>
          {label}
        </text>
      </g>
    );
  };

  const stroke = shade(shirtColor, -0.14);
  const body = `M152,${top} C170,${top + 14} 230,${top + 14} 248,${top} L330,${top + 26} L384,${top + 98} L336,${top + 126} L310,${top + 102} L310,${hem} L90,${hem} L90,${top + 102} L64,${top + 126} L16,${top + 98} L70,${top + 26} Z`;
  const drawn = (side: "back" | "front") => (
    <>
      <path d={body} fill={shirtColor} stroke={stroke} strokeWidth={2} />
      <path d={`M152,${top} C170,${top + (side === "back" ? 10 : 40)} 230,${top + (side === "back" ? 10 : 40)} 248,${top}`} fill={side === "back" ? "none" : "rgba(0,0,0,0.12)"} stroke={stroke} strokeWidth={side === "back" ? 3 : 2} />
    </>
  );

  const line = photos ? 3 : 1;
  /** A sponsor at its own proportions, centred on x; on the sleeve, turned. */
  const box = (sp: PreviewLogo, x: number, y: number, transform?: string) => {
    const w = sp.widthCm * u;
    if (sp.src) {
      return (
        <g transform={transform}>
          <FittedImage href={sp.src} cx={x} y={y} width={w} fallback={2.5} />
        </g>
      );
    }
    const h = w * 0.4;
    return (
      <g transform={transform}>
        <rect x={x - w / 2} y={y} width={w} height={h} rx={3} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={line} opacity={0.8} />
        <text x={x} y={y + h / 2 + h * 0.15} textAnchor="middle" fontSize={Math.min(photos ? 30 : 12, h * 0.45)} fill={ink} opacity={0.85} fontFamily="inherit">
          SPONSOR
        </text>
      </g>
    );
  };
  const backSponsor = sponsors.find((s) => s.place === "back");
  // The back sponsor at its own proportions: the name goes under it.
  const backAspect = useAspect(backSponsor?.src ?? null);
  const chest = sponsors.find((s) => s.place === "chest");
  const sleeve = sponsors.find((s) => s.place === "sleeve");

  // Back, top down: sponsor, name, a hand's width (~3 cm), number.
  const sponsorTop = top + 0.08 * L;
  let y = backSponsor ? sponsorTop + (backSponsor.widthCm * u) / (backAspect ?? 2.5) + 2 * u : top + 0.11 * L;
  const nameBase = y + nameCm * u;
  if (name) y = nameBase + 3 * u;
  else y = Math.max(y, top + 0.19 * L);
  const numberBase = y + numberCm * u;

  // Front: the club logo (a placeholder) on the left chest, initials under it.
  const logoCm = 7;
  const logoTop = top + 0.2 * L;
  const side = PACK.chestSide * chart.chest;
  const initialsBase = logoTop + logoCm * u + 1.5 * u + initialsCm * u;

  // The printed sizes, flat, for the caption.
  const cm = (n: number) => `${Math.round(n)}`;
  const caption = [
    name ? `Namn ${cm(nameCm)} × ${cm(nameWidth)} cm` : "",
    number ? `nummer ${cm(numberCm)} × ${cm(numberWidth)} cm` : "",
    `tröja ${size}: ${chart.chest} cm bred, ${chart.length} cm lång (platt), ryggen rymmer ca ${cm(room)} cm`,
  ].filter(Boolean);

  const picture = (which: "back" | "front") => (
    <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={which === "back" ? "Tröjans baksida" : "Tröjans framsida"}>
      {which === "back" ? (
        <>
          {photos ? <Shot href={back!} /> : drawn("back")}
          {backSponsor && box(backSponsor, cx, sponsorTop)}
          {name && (nameWidth > room ? doesNotFit("Namnet får inte plats", nameCm, nameBase) : wrapped(name, nameFamily, nameCm, "HANDE", 0, nameBase))}
          {number && (numberWidth > room ? doesNotFit("Numret får inte plats", numberCm, numberBase) : wrapped(number, numberFamily, numberCm, "0123456789", 0, numberBase))}
        </>
      ) : (
        <>
          {photos ? <Shot href={front!} /> : drawn("front")}
          {initials && (
            <>
              <circle cx={toX(side)} cy={logoTop + (logoCm * u) / 2} r={(logoCm * u) / 2} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={line} opacity={0.6} />
              <text x={toX(side)} y={logoTop + (logoCm * u) / 2 + 2.2 * u * 0.35} textAnchor="middle" fontSize={2.2 * u} fill={ink} opacity={0.6} fontFamily="inherit">
                LOGGA
              </text>
              {wrapped(initials, nameFamily, initialsCm, "HANDE", side, initialsBase)}
            </>
          )}
          {chest && box(chest, cx, top + 0.36 * L)}
          {sleeve && (photos ? box(sleeve, W * 0.12, PACK.h * 0.22, `rotate(-62 ${W * 0.12} ${PACK.h * 0.24})`) : box(sleeve, 52, top + 64, `rotate(-52 52 ${top + 70})`))}
        </>
      )}
    </svg>
  );

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {(["back", "front"] as const).map((which) => (
          <figure key={which} style={{ margin: 0, textAlign: "center" }}>
            <button
              type="button"
              onClick={() => setZoomed(which)}
              aria-label={`Förstora ${which === "back" ? "baksidan" : "framsidan"}`}
              style={{ display: "block", width: "100%", padding: 0, border: "none", background: "none", cursor: "zoom-in", borderRadius: 10, overflow: "hidden" }}
            >
              {picture(which)}
            </button>
            <figcaption style={{ fontSize: 12.5, color: "#6b6b70" }}>{which === "back" ? "Bak" : "Fram"} · klicka för att förstora</figcaption>
          </figure>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: "#6b6b70", lineHeight: 1.45, marginTop: 6, textAlign: "center" }}>{caption.join(" · ")}</div>
      {zoomed && <Zoom side={zoomed} onSide={setZoomed} onClose={() => setZoomed(null)} picture={picture} />}
    </div>
  );
}

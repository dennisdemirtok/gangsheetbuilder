import type { TextSpec } from "../utils/textRender";

/**
 * What a team can order on "Namn och Siffror": the styles, colours and
 * sizes from TransferCraft's own number catalogue. Kantig, Teknisk, Liga
 * and Digital are TransferCraft's own figures, drawn after the shop's
 * sample sheet (fonts tc-*); the other styles use free fonts close to the
 * catalogue.
 */

export type Setup = "names" | "numbers" | "both";

export interface Style {
  id: string;
  label: string;
  fontId: string;
  /**
   * The outline as on the sample sheet: "double" is a line, a gap in the
   * fill colour, and a second line just inside the figure's edge.
   */
  outline?: "double";
  /** Outline thickness for this style when not the usual OUTLINE_WIDTH. */
  outlineWidth?: number;
}

export const NAME_STYLES: Style[] = [
  { id: "smal", label: "Smal", fontId: "roboto-condensed" },
  { id: "fet", label: "Fet", fontId: "arimo" },
  { id: "college", label: "College", fontId: "graduate" },
  { id: "block", label: "Block", fontId: "anton" },
];

export const NUMBER_STYLES: Style[] = [
  { id: "standard", label: "Standard", fontId: "anton" },
  // Block figures with a flagged 1, as on the catalogue's retro numbers.
  // Graduate (still the College letters) draws its zero with a dot inside.
  { id: "retro", label: "Retro", fontId: "bungee" },
  { id: "sport", label: "Sport", fontId: "rokkitt" },
  { id: "kantig", label: "Kantig", fontId: "tc-kantig", outline: "double" },
  { id: "teknisk", label: "Teknisk", fontId: "tc-teknisk", outline: "double" },
  { id: "liga", label: "Liga", fontId: "tc-liga", outline: "double" },
  // Each segment outlined on its own with a hairline, as on the sample:
  // thicker, the lines of neighbouring segments ran together in the joins.
  // Printed never thinner than MIN_LINE_MM, so 1 mm on 5 and 7 cm numbers.
  { id: "digital", label: "Digital", fontId: "tc-digital", outlineWidth: 0.008 },
];

/** A few more, for a team that wants something of its own. */
export const EXTRA_STYLES: Style[] = [
  { id: "bebas", label: "Bebas", fontId: "bebas-neue" },
  { id: "oswald", label: "Oswald", fontId: "oswald" },
  { id: "racing", label: "Racing", fontId: "racing-sans-one" },
  { id: "stencil", label: "Stencil", fontId: "black-ops-one" },
  { id: "slab", label: "Slab", fontId: "alfa-slab-one" },
];

export function styleById(id: string): Style {
  return [...NAME_STYLES, ...NUMBER_STYLES, ...EXTRA_STYLES].find((s) => s.id === id) ?? NUMBER_STYLES[0]!;
}

export const COLORS: { value: string; label: string }[] = [
  { value: "#ffffff", label: "Vit" },
  { value: "#111111", label: "Svart" },
  { value: "#f5c400", label: "Gul" },
  { value: "#d1202f", label: "Röd" },
  { value: "#1f4fbf", label: "Blå" },
  { value: "#1d2742", label: "Marinblå" },
  { value: "#1f7a3a", label: "Grön" },
  { value: "#f08a24", label: "Orange" },
  { value: "#c9a227", label: "Guld" },
  { value: "#a7abb0", label: "Silver" },
];

export const OUTLINES: { value: string; label: string }[] = [
  { value: "none", label: "Ingen" },
  { value: "#111111", label: "Svart" },
  { value: "#ffffff", label: "Vit" },
];

/**
 * Outline thickness as a share of the font size: about 2.5 % of the
 * figures' height, as on TransferCraft's own number transfers (a thin
 * edge, about 6 mm on a 25 cm number). 0.07 drew ten per cent, a band
 * thick enough to change the shape of the numbers.
 */
export const OUTLINE_WIDTH = 0.018;

/**
 * The double outline, measured on the sample sheet's outlined 7, as shares
 * of the font size: a 1.7 % line, a 2.3 % gap and a 2.9 % line inside the
 * figure (of its height). No line prints thinner than MIN_LINE_MM
 * (utils/textRender): on a 5 cm number the outer line is drawn 1 mm.
 */
export const DOUBLE_OUTLINE = { outer: 0.012, gap: 0.016, inner: 0.02 };

export const NAME_SIZES_CM = [5, 7];
export const NUMBER_SIZES_CM = [5, 7, 10, 20, 25];

export function colorLabel(value: string): string {
  return COLORS.find((c) => c.value === value)?.label ?? value;
}

export interface Look {
  setup: Setup;
  nameStyle: string;
  numberStyle: string;
  color: string;
  outline: string;
  nameCm: number;
  numberCm: number;
  uppercase: boolean;
}

export const DEFAULT_LOOK: Look = {
  setup: "both",
  nameStyle: "smal",
  numberStyle: "standard",
  color: "#ffffff",
  outline: "none",
  nameCm: 7,
  numberCm: 25,
  uppercase: true,
};

export function specFor(text: string, styleId: string, look: Look): TextSpec {
  const outline = look.outline !== "none" ? look.outline : null;
  const style = styleById(styleId);
  const double = Boolean(outline) && style.outline === "double";
  return {
    text,
    fontId: style.fontId,
    color: look.color,
    outline: outline ? (double ? DOUBLE_OUTLINE.outer : (style.outlineWidth ?? OUTLINE_WIDTH)) : 0,
    outlineColor: outline ?? "#111111",
    ...(double ? { outlineGap: DOUBLE_OUTLINE.gap, inlineWidth: DOUBLE_OUTLINE.inner } : {}),
    align: "center",
  };
}

/** The colour that stands out against `color`: for outlines that are picked for you. */
export function contrastOf(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

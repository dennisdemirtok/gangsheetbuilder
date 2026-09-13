/**
 * What a line on a Shopify order asks the print shop to make.
 *
 * The app only knew gang sheets it had built itself. Everything else sold
 * for printing — DTF Transfers By Size, cut out per design, and the UV DTF
 * and special transfers on their own products — never reached the print
 * shop's queue, and the BWS booking treated those lines like heat presses
 * that do not ship from Poland.
 *
 * The print type is the Shopify product type ("DTF Transfer", "UV DTF",
 * "PolyBlock", …), so a new product gets the right label by setting its
 * type in Shopify. Titles are the fallback while product types are blank.
 */

export type PrintKind = "gang_sheet" | "cut";

export const DEFAULT_PRINT_TYPE = "DTF Transfer";

/** Products that are sold alongside transfers but are not printed. */
const NOT_PRINTED = /press|maskin|machine|blank|t-shirt|hoodie|tröja|keps|cap\b/i;

const KNOWN_TYPES: [RegExp, string][] = [
  [/uv[\s-]?dtf/i, "UV DTF"],
  [/polyblock|blocker/i, "PolyBlock"],
  [/flexi[\s-]?stretch/i, "FlexiStretch"],
  [/3d[\s-]?silicone/i, "3D Silicone"],
  [/classic[\s-]?press/i, "ClassicPress"],
  [/dtf|transfer|gang[\s-]?sheet/i, DEFAULT_PRINT_TYPE],
];

/**
 * The print type of a product, or null when the product is not printed
 * (presses, blanks). A product type set in Shopify wins over the title.
 */
export function detectPrintType(
  productType: string | null | undefined,
  title: string | null | undefined,
): string | null {
  const type = (productType || "").trim();
  if (type) {
    if (NOT_PRINTED.test(type)) return null;
    const known = KNOWN_TYPES.find(([re]) => re.test(type));
    if (known) {
      // Keep the shop's own wording ("DTF Transfers") but not a generic type
      // like "Gang sheet", which would read "Gang sheet · Gang sheet on roll".
      return known[1] === DEFAULT_PRINT_TYPE && /dtf|transfer/i.test(type)
        ? type
        : known[1];
    }
  }
  const name = title || "";
  if (NOT_PRINTED.test(name)) return null;
  return KNOWN_TYPES.find(([re]) => re.test(name))?.[1] ?? null;
}

export interface LineProperty {
  name: string;
  value: string;
}

/**
 * The customer's uploaded motif. Only Shopify's own CDN is accepted: cart
 * properties are free text anyone can set, and the worker downloads this.
 */
export function findUploadedFile(properties: LineProperty[]): string | null {
  for (const p of properties) {
    const value = String(p.value || "").trim();
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "cdn.shopify.com") {
        return url.toString();
      }
    } catch {
      // not a URL
    }
  }
  return null;
}

/** Properties worth showing: not internal (_…) and not the file link itself. */
export function visibleProperties(properties: LineProperty[]): LineProperty[] {
  return properties.filter(
    (p) => p.name && !p.name.startsWith("_") && !findUploadedFile([p]) && String(p.value).trim(),
  );
}

/** "Bredd (cm)" = "10,5" → 105 mm. */
export function propertyMm(properties: LineProperty[], pattern: RegExp): number {
  const p = properties.find((x) => pattern.test(x.name));
  const cm = parseFloat(String(p?.value ?? "").replace(",", "."));
  return Number.isFinite(cm) && cm > 0 ? Math.round(cm * 10) : 0;
}

interface JobLike {
  kind?: string | null;
  printType?: string | null;
  lineQuantity?: number | null;
  widthMm: number;
  heightMm: number;
}

export const KIND_LABEL: Record<PrintKind, string> = {
  gang_sheet: "Gang sheet on roll",
  cut: "Cut per design",
};

/** "DTF Transfer · Cut per design". */
export function printLabel(job: JobLike): string {
  const kind = (job.kind as PrintKind) || "gang_sheet";
  return `${job.printType || DEFAULT_PRINT_TYPE} · ${KIND_LABEL[kind] ?? kind}`;
}

/** "58 × 100 cm", or "10 × 8 cm × 20 pcs" for cut jobs. */
export function jobSize(job: JobLike): string {
  const size =
    job.widthMm > 0 && job.heightMm > 0
      ? `${job.widthMm / 10} × ${job.heightMm / 10} cm`
      : "Size not given";
  return job.kind === "cut" && job.lineQuantity
    ? `${size} × ${job.lineQuantity} pcs`
    : size;
}

/**
 * Film the job uses, in metres of 58 cm roll. A cut job's motifs are
 * printed side by side, so its area is what counts, not one motif's height.
 */
export function filmMetres(job: JobLike): number {
  if (job.kind === "cut") {
    return (job.widthMm * job.heightMm * (job.lineQuantity || 1)) / (580 * 1000);
  }
  return job.heightMm / 1000;
}

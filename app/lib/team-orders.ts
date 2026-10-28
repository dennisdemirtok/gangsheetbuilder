/**
 * Team orders (lagpaket) from /pages/lag, split three ways:
 *
 * - shirts: Clique from New Wave, ordered by the shop on newwave.se and
 *   delivered by New Wave straight to the customer;
 * - digits: product "Lagsiffror", picked from the shop's own stock in Sweden;
 * - logos: club and sponsor logos on the order's print sheet, printed in
 *   Poland and sent to the shop, which packs them with the digits.
 *
 * Kept free of server imports so the pages can use it too.
 */

export interface TeamShirt {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  color: string;
  size: string;
}

export interface TeamDigit {
  style: string;
  heightCm: number;
  color: string;
  digit: number;
  quantity: number;
  sku: string | null;
}

export interface TeamLogo {
  label: string;
  quantity: number;
  width: string | null;
  placement: string | null;
}

export interface TeamLine {
  id: number | string;
  product_id?: number | string | null;
  title?: string;
  variant_title?: string | null;
  sku?: string | null;
  vendor?: string | null;
  quantity?: number;
  properties?: { name: string; value: string }[] | null;
}

/** Bought from New Wave in Dingle, never from Printgood (see garments.ts). */
export const NEW_WAVE_VENDOR = /clique|new\s*wave|\bcraft\b/i;
export const DIGITS_PRODUCT_TYPE = /^lagsiffror$/i;

const prop = (line: TeamLine, name: string) => line.properties?.find((p) => p.name === name)?.value?.trim() || null;

/** "Royalblå / 130/140": the size itself has a slash, so split on " / ". */
function splitVariant(title: string | null | undefined): string[] {
  return (title || "").split(" / ").map((s) => s.trim());
}

export function isTeamShirt(line: TeamLine): boolean {
  return NEW_WAVE_VENDOR.test(line.vendor || "");
}

export function isTeamDigit(line: TeamLine, productType?: string | null): boolean {
  return DIGITS_PRODUCT_TYPE.test((productType || "").trim()) || /^LS-/.test(line.sku || "");
}

/** "Arena 20 cm / Vit / 7" → style, height, colour and figure. */
export function parseDigit(line: TeamLine): TeamDigit | null {
  const [styleHeight, color, figure] = splitVariant(line.variant_title);
  const m = /^(.+?)\s+(\d+)\s*cm$/i.exec(styleHeight || "");
  const digit = parseInt(figure || "", 10);
  if (!m || !color || !(digit >= 0 && digit <= 9)) return null;
  return { style: m[1]!, heightCm: parseInt(m[2]!, 10), color, digit, quantity: line.quantity ?? 1, sku: line.sku || null };
}

export interface TeamSplit {
  team: string | null;
  shirts: TeamShirt[];
  digits: TeamDigit[];
  logos: TeamLogo[];
}

/** What of an order belongs to a team order. Empty shirts and digits: none. */
export function splitTeamOrder(lines: TeamLine[], productTypes: Map<string, string>): TeamSplit {
  const out: TeamSplit = { team: null, shirts: [], digits: [], logos: [] };
  for (const line of lines) {
    if ((line.quantity ?? 0) <= 0) continue;
    const type = productTypes.get(String(line.product_id ?? "")) ?? null;
    if (isTeamShirt(line)) {
      const [color, size] = splitVariant(line.variant_title);
      out.shirts.push({
        lineItemId: String(line.id),
        title: line.title ?? "",
        variantTitle: line.variant_title ?? null,
        sku: line.sku || null,
        quantity: line.quantity ?? 1,
        color: color || "",
        size: size || "",
      });
    } else if (isTeamDigit(line, type)) {
      const digit = parseDigit(line);
      if (digit) out.digits.push(digit);
    } else if (prop(line, "_nn") && prop(line, "Logga")) {
      out.logos.push({
        label: prop(line, "Logga")!,
        quantity: line.quantity ?? 1,
        width: prop(line, "Bredd"),
        placement: prop(line, "Placering"),
      });
    }
    out.team = out.team || prop(line, "Lag");
  }
  return out;
}

export function isTeamOrder(split: TeamSplit): boolean {
  return split.shirts.length > 0 || split.digits.length > 0;
}

/** New Wave's article and colour code from our SKU: 029037-55-130140 → 029037-55. */
export function newWaveArticle(sku: string | null): string {
  const m = /^(\d{6})-(\d{2,3})/.exec(sku || "");
  return m ? `${m[1]}-${m[2]}` : sku || "";
}

/** The shirts as one line each, to type or paste into newwave.se. */
export function newWaveOrderText(shirts: TeamShirt[], address: Record<string, string | null> | null): string {
  const lines = shirts.map((s) => `${newWaveArticle(s.sku)}  ${s.title}, ${s.color}, ${s.size}  × ${s.quantity}`);
  const to = address
    ? [address.name, address.company, address.address1, address.address2, [address.zip, address.city].filter(Boolean).join(" "), address.country, address.phone]
        .filter(Boolean)
        .join("\n")
    : "";
  return [...lines, "", "Leverans direkt till:", to].join("\n").trim();
}

/** Digits grouped for picking: "Arena 20 cm, Vit" → counts for 0-9. */
export function digitPickList(digits: TeamDigit[]): { group: string; counts: number[]; total: number }[] {
  const groups = new Map<string, number[]>();
  for (const d of digits) {
    const key = `${d.style} ${d.heightCm} cm, ${d.color}`;
    const counts = groups.get(key) ?? (Array(10).fill(0) as number[]);
    counts[d.digit] = (counts[d.digit] ?? 0) + d.quantity;
    groups.set(key, counts);
  }
  return [...groups.entries()].map(([group, counts]) => ({ group, counts, total: counts.reduce((a, b) => a + b, 0) }));
}

/**
 * Where an order stands. The shop's own parcel (digits, logos) is only
 * needed when there is something in it; a shirts-only order is done once
 * New Wave has it.
 */
export function teamStatus(order: {
  status: string;
  newWaveOrderedAt: Date | string | null;
  shippedAt: Date | string | null;
  shirts: unknown;
  digits: unknown;
  logos: unknown;
}): string {
  if (order.status === "cancelled") return "cancelled";
  const hasShirts = Array.isArray(order.shirts) && order.shirts.length > 0;
  const ownParcel = (Array.isArray(order.digits) && order.digits.length > 0) || (Array.isArray(order.logos) && order.logos.length > 0);
  const shirtsDone = !hasShirts || Boolean(order.newWaveOrderedAt);
  const parcelDone = !ownParcel || Boolean(order.shippedAt);
  if (shirtsDone && parcelDone) return "shipped";
  if (order.newWaveOrderedAt || order.shippedAt) return "ordered";
  return "new";
}

export const TEAM_STATUS: Record<string, { label: string; tone: "info" | "attention" | "success" | "warning" | undefined }> = {
  new: { label: "To do", tone: "attention" },
  ordered: { label: "In progress", tone: "info" },
  shipped: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: undefined },
};

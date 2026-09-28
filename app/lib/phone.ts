/**
 * Phone numbers in international format, as couriers need them.
 *
 * "0730 25 55 76" in Sweden is +46730255576: the leading 0 is the domestic
 * trunk prefix and is dropped after the country code. "+460730…" is a
 * common mistake that a courier dialling from abroad cannot reach.
 */
const DIAL: Record<string, string> = {
  SE: "46", NO: "47", DK: "45", FI: "358", DE: "49", PL: "48", GB: "44", NL: "31",
};

export function normalizePhone(input: string, countryCode?: string | null): string {
  let n = input.replace(/[^\d+]/g, "");
  if (!n) return "";
  if (n.startsWith("00")) n = `+${n.slice(2)}`;
  if (!n.startsWith("+")) {
    const cc = DIAL[(countryCode || "SE").toUpperCase()] ?? "46";
    n = `+${cc}${n.replace(/^0/, "")}`;
  }
  // "+46 0730…" → "+46730…"
  for (const cc of Object.values(DIAL)) {
    if (n.startsWith(`+${cc}0`)) return `+${cc}${n.slice(cc.length + 2)}`;
  }
  return n;
}

/**
 * Clothes sold blank (Stanley/Stella, B&C) and dropshipped from Printgood in
 * Kryspinów, Poland. Feelgood (Danuta) prepares them; the parcel can only be
 * booked once they approve the pickup. None of this touches the print jobs.
 */

export interface GarmentItem {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  vendor: string | null;
  /** Price per piece the customer paid, SEK. */
  unitPrice: number | null;
}

export const SUPPLIER_EMAIL = process.env.GARMENT_SUPPLIER_EMAIL || "danuta.lewkowicz@feelgood.pl";
export const SUPPLIER_NAME = "Feelgood";

/** Where the courier collects the clothes (from Printgood's shipping label). */
export const GARMENT_PICKUP = {
  name: "Printgood",
  company: "Printgood",
  contact: process.env.GARMENT_PICKUP_CONTACT || "Jarek Matias",
  address1: process.env.GARMENT_PICKUP_ADDRESS || "ul. Blonia 2",
  zip: process.env.GARMENT_PICKUP_ZIP || "32-060",
  city: process.env.GARMENT_PICKUP_CITY || "Kryspinów",
  countryCode: "PL",
  phone: process.env.GARMENT_PICKUP_PHONE || "+48605213212",
};

/** A parcel of folded clothes, not the print shop's 60 cm tube. */
export const GARMENT_PACKAGE_CM = { length: 40, width: 30, height: 15 };

const GARMENT_VENDOR = /stanley|b\s*&\s*c/i;
const GARMENT_TYPE = /t-?shirt|hoodie|sweatshirt|pik[eé]|polo|tröja|crew\s*neck/i;
/**
 * Team wear bought from New Wave in Dingle (Clique, later Craft), not from
 * Printgood: Feelgood has none of it, so it stays out of their email and is
 * ordered on newwave.se.
 */
const NEW_WAVE_VENDOR = /clique|new\s*wave|\bcraft\b/i;

/** A blank garment Printgood ships: by brand, or by product type for a brand added later. */
export function isGarment(line: { vendor?: string | null }, productType?: string | null): boolean {
  if (NEW_WAVE_VENDOR.test(line.vendor || "")) return false;
  return GARMENT_VENDOR.test(line.vendor || "") || GARMENT_TYPE.test(productType || "");
}

export function garmentPieces(items: GarmentItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

/**
 * The same garment can sit on several order lines (one per print option);
 * Feelgood picks by SKU, so the email and the page list each SKU once.
 */
export function itemsBySku(items: GarmentItem[]): GarmentItem[] {
  const out = new Map<string, GarmentItem>();
  for (const item of items) {
    const key = item.sku || `${item.title}|${item.variantTitle ?? ""}`;
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, quantity: prev.quantity + item.quantity } : { ...item });
  }
  return [...out.values()].sort((a, b) => (a.sku || a.title).localeCompare(b.sku || b.title));
}

/** Roughly: hoodies and sweatshirts 0.6 kg, the rest 0.25 kg, plus the box. */
export function estimateWeightKg(items: GarmentItem[]): number {
  const kg = items.reduce(
    (sum, i) => sum + i.quantity * (/hood|sweat|crew|zip|drummer|cruiser|changer|cultivator|king/i.test(i.title) ? 0.6 : 0.25),
    0.3,
  );
  return Math.max(1, Math.ceil(kg));
}

export function garmentsValueSEK(items: GarmentItem[]): number {
  return Math.round(items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0));
}

export const GARMENT_STATUS: Record<string, { label: string; tone: "info" | "attention" | "success" | "warning" | undefined }> = {
  new: { label: "To send", tone: "attention" },
  sent: { label: "Waiting for booking", tone: "warning" },
  booked: { label: "Pickup booked", tone: "info" },
  shipped: { label: "Shipped", tone: "success" },
  cancelled: { label: "Cancelled", tone: undefined },
};

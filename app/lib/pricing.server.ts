import prisma from "../db.server";
import { DEFAULT_PRICES_SEK, DEFAULT_FILM_MODIFIERS } from "./constants";

export interface PriceResult {
  basePrice: number;
  filmModifier: number;
  totalPrice: number;
  sizeKey: string;
  filmType: string;
}

/**
 * Calculate the price for a gang sheet based on size and film type.
 */
export async function calculatePrice(
  shopDomain: string,
  sizeKey: string,
  filmType: string = "standard",
): Promise<PriceResult> {
  // Try to load shop-specific config
  const config = await prisma.appConfig.findUnique({
    where: { shopDomain },
  });

  const prices = (config?.priceConfig as Record<string, number>) || DEFAULT_PRICES_SEK;
  const modifiers = (config?.filmModifiers as Record<string, number>) || DEFAULT_FILM_MODIFIERS;

  const basePrice = prices[sizeKey] || 0;
  const filmModifier = modifiers[filmType] || 1.0;
  const totalPrice = Math.round(basePrice * filmModifier);

  return {
    basePrice,
    filmModifier,
    totalPrice,
    sizeKey,
    filmType,
  };
}

/**
 * Get all prices for the price display in the editor.
 */
export async function getAllPrices(
  shopDomain: string,
): Promise<Record<string, Record<string, number>>> {
  const config = await prisma.appConfig.findUnique({
    where: { shopDomain },
  });

  const prices = (config?.priceConfig as Record<string, number>) || DEFAULT_PRICES_SEK;
  const modifiers = (config?.filmModifiers as Record<string, number>) || DEFAULT_FILM_MODIFIERS;

  const result: Record<string, Record<string, number>> = {};
  for (const [sizeKey, basePrice] of Object.entries(prices)) {
    result[sizeKey] = {};
    for (const [filmType, modifier] of Object.entries(modifiers)) {
      result[sizeKey][filmType] = Math.round(basePrice * modifier);
    }
  }
  return result;
}

/**
 * Resolve a Shopify variant ID from size + film type.
 */
export async function resolveVariantId(
  shopDomain: string,
  sizeKey: string,
  filmType: string,
): Promise<string | null> {
  const config = await prisma.appConfig.findUnique({
    where: { shopDomain },
  });

  if (!config?.variantMapping) return null;

  const mapping = config.variantMapping as Record<string, string>;
  return mapping[`${sizeKey}_${filmType}`] || null;
}

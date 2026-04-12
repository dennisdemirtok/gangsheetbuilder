import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getAllPrices, calculatePrice } from "../lib/pricing.server";

/**
 * Get pricing information for the editor.
 * Returns all prices per size/film combination.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const sizeKey = url.searchParams.get("size");
  const filmType = url.searchParams.get("film");

  // If specific size + film requested, return that price
  if (sizeKey && filmType) {
    const price = await calculatePrice(session.shop, sizeKey, filmType);
    return json({ price });
  }

  // Otherwise return all prices
  const prices = await getAllPrices(session.shop);
  return json({ prices });
};

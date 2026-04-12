import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VALID_FILM_TYPES = ["standard", "glitter", "glow", "gold_foil", "silver_foil"];

/**
 * List gang sheets for a session (GET) or create a new one (POST).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      return json({ error: "Missing sessionId" }, { status: 400 });
    }

    const gangSheets = await prisma.gangSheet.findMany({
      where: { sessionId, shopDomain: session.shop },
      include: { images: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return json({ gangSheets });
  } catch (error) {
    console.error("Gang sheet list error:", error);
    return json({ error: "Failed to load gang sheets" }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "Unauthorized" }, { status: 401 });

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json();
    const { sessionId, widthMm, heightMm, filmType } = body;

    if (!sessionId || !widthMm || !heightMm) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    if (widthMm <= 0 || heightMm <= 0 || widthMm > 10000 || heightMm > 100000) {
      return json({ error: "Invalid dimensions" }, { status: 400 });
    }

    const validFilmType = VALID_FILM_TYPES.includes(filmType) ? filmType : "standard";

    const gangSheet = await prisma.gangSheet.create({
      data: {
        sessionId,
        shopDomain: session.shop,
        widthMm: Math.round(widthMm),
        heightMm: Math.round(heightMm),
        filmType: validFilmType,
      },
    });

    return json({ gangSheet });
  } catch (error) {
    console.error("Gang sheet create error:", error);
    return json({ error: "Failed to create gang sheet" }, { status: 500 });
  }
};

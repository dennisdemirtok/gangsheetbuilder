import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { isTeamOrder, splitTeamOrder, type TeamLine } from "./team-orders";

/**
 * Record a team order for the Team orders list. Called from the order intake
 * next to the print jobs and the clothes: the logos still become a print job
 * of their own, this only keeps track of the New Wave shirts and the stock
 * digits that go with them.
 */

interface TeamAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
}

export interface TeamOrderPayload {
  id: number;
  name?: string;
  email?: string | null;
  phone?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  shipping_address?: TeamAddress | null;
  billing_address?: TeamAddress | null;
  line_items: TeamLine[];
}

/** The address a team order's logos go to, set on the Team orders page. */
export async function teamShipTo(shop: string): Promise<Record<string, string> | null> {
  const config = await prisma.appConfig.findUnique({ where: { shopDomain: shop }, select: { teamShipTo: true } });
  const to = config?.teamShipTo as Record<string, string> | null | undefined;
  return to && to.address1 && to.zip && to.city ? to : null;
}

export async function intakeTeamOrder(
  shop: string,
  order: TeamOrderPayload,
  productTypes: Map<string, string>,
): Promise<boolean> {
  const split = splitTeamOrder(order.line_items || [], productTypes);
  if (!isTeamOrder(split)) return false;

  const key = { shopDomain: shop, shopifyOrderId: String(order.id) };
  const existing = await prisma.teamOrder.findUnique({
    where: { shopDomain_shopifyOrderId: key },
    select: { status: true, newWaveOrderedAt: true, shippedAt: true },
  });
  // Once the shop has started on it, a webhook redelivery must not change it.
  if (existing && (existing.status !== "new" || existing.newWaveOrderedAt || existing.shippedAt)) return true;

  const ship = order.shipping_address || order.billing_address || null;
  const data = {
    orderName: order.name ? String(order.name) : null,
    customerName:
      ship?.name || [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") || null,
    team: split.team,
    shippingAddress: ship
      ? {
          name: ship.name ?? null,
          company: ship.company ?? null,
          address1: ship.address1 ?? null,
          address2: ship.address2 ?? null,
          zip: ship.zip ?? null,
          city: ship.city ?? null,
          country: ship.country ?? null,
          countryCode: ship.country_code ?? null,
          phone: ship.phone ?? order.phone ?? null,
          email: order.email ?? null,
        }
      : Prisma.DbNull,
    shirts: split.shirts as unknown as Prisma.InputJsonArray,
    digits: split.digits as unknown as Prisma.InputJsonArray,
    logos: split.logos as unknown as Prisma.InputJsonArray,
  };
  await prisma.teamOrder.upsert({
    where: { shopDomain_shopifyOrderId: key },
    create: { ...key, ...data },
    update: data,
  });
  return true;
}

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";

interface SheetRef {
  shopifyOrderId: string | null;
  orderName: string | null;
  customerName: string | null;
  shippingAddress: Prisma.JsonValue | null;
}

interface OrderNode {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  shippingAddress: {
    name: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    zip: string | null;
    city: string | null;
    country: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
}

/**
 * Fill in order number, recipient and address on sheets that lack them.
 *
 * The paid-order webhook copies these onto the sheet, but sheets paid before
 * it did (and any delivery that failed) showed "#13513260728694" and "No
 * shipping address" — useless to a print shop that has to post the parcel.
 * Looks the orders up once, saves the result, and returns the rows patched
 * so the page that asked shows the names straight away.
 */
export async function withOrderDetails<T extends SheetRef>(
  admin: AdminApiContext,
  shopDomain: string,
  sheets: T[],
): Promise<T[]> {
  const missing = [
    ...new Set(
      sheets
        .filter((s) => s.shopifyOrderId && !s.orderName)
        .map((s) => s.shopifyOrderId as string),
    ),
  ];
  if (missing.length === 0) return sheets;

  let nodes: OrderNode[] = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query OrderDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            email
            phone
            shippingAddress {
              name company address1 address2 zip city country countryCodeV2 phone
            }
          }
        }
      }`,
      { variables: { ids: missing.map((id) => `gid://shopify/Order/${id}`) } },
    );
    const body = await response.json();
    nodes = (body.data?.nodes ?? []).filter((n: OrderNode | null) => n?.name);
  } catch (err) {
    // Names are a convenience; the page must still load without them.
    console.error("[order-details] Could not look up orders:", err);
    return sheets;
  }

  const found = new Map<string, Pick<SheetRef, "orderName" | "customerName" | "shippingAddress">>();
  await Promise.all(
    nodes.map(async (order) => {
      const orderId = order.id.split("/").pop()!;
      const ship = order.shippingAddress;
      const details = {
        orderName: order.name,
        customerName: ship?.name ?? null,
        shippingAddress: ship
          ? {
              name: ship.name,
              company: ship.company,
              address1: ship.address1,
              address2: ship.address2,
              zip: ship.zip,
              city: ship.city,
              country: ship.country,
              countryCode: ship.countryCodeV2,
              phone: ship.phone ?? order.phone,
              email: order.email,
            }
          : null,
      };
      found.set(orderId, details);

      const existing = sheets.find((s) => s.shopifyOrderId === orderId);
      if (!existing?.shippingAddress && details.shippingAddress) {
        // A booking refused for lack of an address can be tried again now.
        await prisma.gangSheet.updateMany({
          where: {
            shopDomain,
            shopifyOrderId: orderId,
            shippingStatus: "failed",
            shippingError: { contains: "no shipping address" },
          },
          data: { shippingStatus: null, shippingError: null },
        });
      }
      await prisma.gangSheet.updateMany({
        where: { shopDomain, shopifyOrderId: orderId, orderName: null },
        data: {
          orderName: details.orderName,
          // Never overwrite what the webhook already stored.
          ...(existing?.customerName ? {} : { customerName: details.customerName }),
          ...(existing?.shippingAddress || !details.shippingAddress
            ? {}
            : { shippingAddress: details.shippingAddress }),
        },
      });
    }),
  );

  return sheets.map((s) => {
    const d = s.shopifyOrderId ? found.get(s.shopifyOrderId) : undefined;
    if (!d || s.orderName) return s;
    return {
      ...s,
      orderName: d.orderName,
      customerName: s.customerName ?? d.customerName,
      shippingAddress: s.shippingAddress ?? d.shippingAddress,
    };
  });
}

/**
 * Bring an order's recipient and address up to date with Shopify.
 *
 * The paid-order webhook copies them onto the sheets once. A name or address
 * corrected on the order in Shopify afterwards never reached the app, so the
 * courier label and the print shop's email carried the old one. Called when
 * the order page opens, and right before a booking or the print shop email,
 * while nothing is booked: a booked label keeps the address it was booked
 * with. A phone number added in the app stays when Shopify has none.
 * Returns true when something changed.
 */
export async function syncOrderAddress(
  admin: AdminApiContext,
  shopDomain: string,
  shopifyOrderId: string,
): Promise<boolean> {
  let order: OrderNode | null = null;
  try {
    const response = await admin.graphql(
      `#graphql
      query OrderAddress($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          shippingAddress {
            name company address1 address2 zip city country countryCodeV2 phone
          }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${shopifyOrderId}` } },
    );
    const body = await response.json();
    order = body.data?.order ?? null;
  } catch (err) {
    // The stored address still works; this only keeps it current.
    console.error("[order-details] Could not refresh the address:", err);
    return false;
  }
  const ship = order?.shippingAddress;
  if (!order || !ship) return false;

  const sheets = await prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId },
    select: { id: true, customerName: true, shippingAddress: true, shippingStatus: true },
  });
  if (sheets.length === 0) return false;
  if (sheets.some((s) => s.shippingStatus === "booked" || s.shippingStatus === "booking")) return false;

  // Edited names come back as "Fredrik  Andersson": one space, no ends, as on a label.
  const clean = (v: string | null | undefined) => (v ? v.replace(/\s+/g, " ").trim() || null : null);

  let changed = false;
  for (const sheet of sheets) {
    const stored = (sheet.shippingAddress as Record<string, string | null> | null) || {};
    const next: Record<string, string | null> = {
      ...stored,
      name: clean(ship.name),
      company: clean(ship.company),
      address1: clean(ship.address1),
      address2: clean(ship.address2),
      zip: clean(ship.zip),
      city: clean(ship.city),
      country: clean(ship.country),
      countryCode: ship.countryCodeV2,
      phone: clean(ship.phone) || clean(order.phone) || stored.phone || null,
      email: clean(order.email) || stored.email || null,
    };
    const customerName = next.name || sheet.customerName;
    if (JSON.stringify(next) === JSON.stringify(stored) && customerName === sheet.customerName) continue;
    await prisma.gangSheet.update({
      where: { id: sheet.id },
      data: { customerName, shippingAddress: next },
    });
    changed = true;
  }
  return changed;
}

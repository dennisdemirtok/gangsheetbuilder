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

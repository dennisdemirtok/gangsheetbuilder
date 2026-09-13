import { unauthenticated } from "../shopify.server";

/**
 * Mark the DTF line items of an order as fulfilled with the BWS tracking, so
 * Shopify sends the customer its shipping confirmation with the tracking
 * link.
 *
 * Only the gang sheet line items are fulfilled. Transfer presses and blanks
 * on the same order do not leave from the print shop in Poland and must stay
 * unfulfilled until they are shipped their own way.
 *
 * Needs read_/write_merchant_managed_fulfillment_orders.
 */

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
  }
`;

const FULFILL_MUTATION = `#graphql
  mutation FulfillWithTracking($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

export type FulfillResult =
  | { ok: true; fulfillmentIds: string[] }
  | { ok: false; error: string };

export async function fulfillLineItemsWithTracking(options: {
  shopDomain: string;
  shopifyOrderId: string;
  /** Numeric Shopify line item ids of the gang sheets. */
  lineItemIds: string[];
  trackingNumber?: string;
  trackingUrl?: string;
}): Promise<FulfillResult> {
  const { shopDomain, shopifyOrderId } = options;
  const wanted = new Set(
    options.lineItemIds.map((id) => `gid://shopify/LineItem/${id}`),
  );
  if (wanted.size === 0) {
    return { ok: false, error: "No DTF line items to fulfil on this order." };
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);

    const res = await admin.graphql(FULFILLMENT_ORDERS_QUERY, {
      variables: { id: `gid://shopify/Order/${shopifyOrderId}` },
    });
    const body: any = await res.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const fulfillmentOrders: any[] = body.data?.order?.fulfillmentOrders?.nodes || [];

    // fulfillmentCreate takes fulfillment orders assigned to one location, so
    // create one fulfillment per fulfillment order that holds DTF items.
    const fulfillmentIds: string[] = [];
    const errors: string[] = [];
    for (const fo of fulfillmentOrders) {
      if (fo.status === "CLOSED" || fo.status === "CANCELLED") continue;
      const lines = (fo.lineItems?.nodes || []).filter(
        (l: any) => wanted.has(l.lineItem?.id) && l.remainingQuantity > 0,
      );
      if (lines.length === 0) continue;

      const mres = await admin.graphql(FULFILL_MUTATION, {
        variables: {
          fulfillment: {
            notifyCustomer: true,
            trackingInfo: {
              company: "Blue Water Shipping",
              ...(options.trackingNumber ? { number: options.trackingNumber } : {}),
              ...(options.trackingUrl ? { url: options.trackingUrl } : {}),
            },
            lineItemsByFulfillmentOrder: [
              {
                fulfillmentOrderId: fo.id,
                fulfillmentOrderLineItems: lines.map((l: any) => ({
                  id: l.id,
                  quantity: l.remainingQuantity,
                })),
              },
            ],
          },
        },
      });
      const mbody: any = await mres.json();
      const payload = mbody.data?.fulfillmentCreate;
      if (mbody.errors) errors.push(JSON.stringify(mbody.errors));
      payload?.userErrors?.forEach((e: any) => errors.push(e.message));
      if (payload?.fulfillment?.id) fulfillmentIds.push(payload.fulfillment.id);
    }

    if (fulfillmentIds.length === 0) {
      return {
        ok: false,
        error: errors.join(" · ") || "Nothing left to fulfil (already fulfilled?).",
      };
    }
    return { ok: true, fulfillmentIds };
  } catch (error) {
    return { ok: false, error: `Shopify fulfilment failed: ${(error as Error).message}` };
  }
}

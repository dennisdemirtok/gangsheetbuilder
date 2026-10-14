import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  EmptySearchResult,
  IndexTable,
  Link as PolarisLink,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { GARMENT_STATUS, garmentPieces, itemsBySku, type GarmentItem } from "../lib/garments";
import { formatDateTime } from "../lib/order-status";

/**
 * Clothes (Stanley/Stella, B&C) dropshipped from Printgood: a list of their
 * own, apart from the print orders. Each order is emailed to Feelgood, waits
 * for their go-ahead, then gets its own BWS pickup at Printgood.
 */

const FILTERS = [
  { value: "open", label: "Open", statuses: ["new", "sent", "booked"] },
  { value: "new", label: "To send", statuses: ["new"] },
  { value: "sent", label: "Waiting for booking", statuses: ["sent"] },
  { value: "booked", label: "Pickup booked", statuses: ["booked"] },
  { value: "shipped", label: "Shipped", statuses: ["shipped"] },
  { value: "all", label: "All", statuses: null },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = FILTERS.find((f) => f.value === url.searchParams.get("status")) ?? FILTERS[0];

  const [orders, grouped] = await Promise.all([
    prisma.garmentOrder.findMany({
      where: {
        shopDomain: session.shop,
        ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
      },
      orderBy: { createdAt: filter.value === "shipped" || filter.value === "all" ? "desc" : "asc" },
      take: 200,
    }),
    prisma.garmentOrder.groupBy({ by: ["status"], where: { shopDomain: session.shop }, _count: true }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));

  return json({
    filter: filter.value,
    counts: Object.fromEntries(
      FILTERS.map((f) => [
        f.value,
        f.statuses ? f.statuses.reduce((n, s) => n + (counts[s] ?? 0), 0) : grouped.reduce((n, g) => n + g._count, 0),
      ]),
    ),
    orders: orders.map((o) => {
      const items = itemsBySku(o.items as unknown as GarmentItem[]);
      return {
        id: o.id,
        label: o.orderName || `#${o.shopifyOrderId}`,
        customerName: o.customerName,
        ordered: formatDateTime(o.createdAt),
        pieces: garmentPieces(items),
        summary: [...new Set(items.map((i) => i.title))].join(", "),
        status: o.status,
        pickupDate: o.pickupDate,
      };
    }),
  });
};

export default function ClothesPage() {
  const { filter, counts, orders } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = Math.max(0, FILTERS.findIndex((f) => f.value === filter));

  const rows = orders.map((order, index) => {
    const status = GARMENT_STATUS[order.status] ?? { label: order.status, tone: undefined };
    return (
      <IndexTable.Row id={order.id} key={order.id} position={index}>
        <IndexTable.Cell>
          <PolarisLink dataPrimaryLink url={`/app/clothes/${order.id}`} removeUnderline monochrome>
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {order.label}
            </Text>
          </PolarisLink>
        </IndexTable.Cell>
        <IndexTable.Cell>{order.customerName || "-"}</IndexTable.Cell>
        <IndexTable.Cell>{order.ordered}</IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="0">
            <Text as="span" variant="bodyMd">
              {order.pieces} {order.pieces === 1 ? "piece" : "pieces"}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {order.summary}
            </Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="0">
            <span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </span>
            {order.status === "booked" && order.pickupDate && (
              <Text as="span" variant="bodySm" tone="subdued">
                Pickup {order.pickupDate}
              </Text>
            )}
          </BlockStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="Clothes" />
      <BlockStack gap="300">
        <Text as="p" tone="subdued">
          Stanley/Stella and B&amp;C, dropshipped from Printgood. Send each order to Feelgood, book
          the pickup when they say it is ready.
        </Text>
        <Card padding="0">
          <Tabs
            tabs={FILTERS.map((f) => ({
              id: f.value,
              content: `${f.label}${counts[f.value] ? ` (${counts[f.value]})` : ""}`,
            }))}
            selected={selected}
            onSelect={(i) => {
              const params = new URLSearchParams(searchParams);
              params.set("status", FILTERS[i].value);
              setSearchParams(params);
            }}
          />
          <IndexTable
            resourceName={{ singular: "order", plural: "orders" }}
            itemCount={orders.length}
            selectable={false}
            headings={[
              { title: "Order" },
              { title: "Customer" },
              { title: "Ordered" },
              { title: "Clothes" },
              { title: "Status" },
            ]}
            emptyState={
              <EmptySearchResult
                title="No orders with clothes here"
                description="Orders with Stanley/Stella or B&C garments show up here when they are paid."
              />
            }
          >
            {rows}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  InlineGrid,
  Divider,
  Button,
  Icon,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { orderLabel, statusInfo } from "../lib/order-status";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  /*
   * Every count is limited to sheets that reached a paid order. The status
   * counters used to include abandoned carts too, so the dashboard showed
   * "Total orders 0" beside "Waiting 4" and the waiting ones led nowhere.
   */
  const real = { shopDomain, shopifyOrderId: { not: null } };

  /*
   * Five queries, all at once.
   *
   * This used to be eleven: one count per status plus a separate total, a
   * revenue aggregate nothing displays, and two more queries that waited
   * for the first batch to finish. The app and its database are far apart,
   * so every round trip costs close to a second — the dashboard sat blank
   * for several seconds. Statuses now come back from a single groupBy.
   */
  const [byStatus, last30Days, totalDesigns, sizeCounts, recentOrders] =
    await Promise.all([
      prisma.gangSheet.groupBy({
        by: ["status"],
        where: real,
        _count: { _all: true },
      }),
      prisma.gangSheet.count({
        where: { ...real, createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.gangSheetImage.count({
        where: { gangSheet: { shopDomain } },
      }),
      prisma.gangSheet.groupBy({
        by: ["widthMm", "heightMm"],
        where: real,
        _count: true,
        orderBy: { _count: { id: "desc" } },
        take: 5,
      }),
      prisma.gangSheet.findMany({
        where: real,
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { _count: { select: { images: true } } },
      }),
    ]);

  const countOf = (status: string) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;
  const total = byStatus.reduce((sum, row) => sum + row._count._all, 0);

  return json({
    stats: {
      total,
      pending: countOf("pending"),
      exported: countOf("exported"),
      downloaded: countOf("downloaded"),
      printed: countOf("printed"),
      shipped: countOf("shipped"),
      last30Days,
      totalDesigns,
    },
    sizeCounts,
    recentOrders,
  });
};

export default function DashboardIndex() {
  const { stats, sizeCounts, recentOrders } = useLoaderData<typeof loader>();
  const toDo =
    stats.pending + stats.exported + stats.downloaded + stats.printed;

  return (
    <Page>
      <TitleBar title="Gang Sheet Builder" />
      <BlockStack gap="500">
        {/* The work queue, in the order a job moves through it. This is
            what the print shop opens the app to see. */}
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {toDo === 0 ? "Nothing to do right now" : `${toDo} orders to handle`}
          </Text>
          <InlineGrid columns={{ xs: 2, sm: 4 }} gap="400">
            <QueueCard
              title="Ready to print"
              value={stats.exported}
              tone="success"
              status="exported"
            />
            <QueueCard
              title="Downloaded"
              value={stats.downloaded}
              status="downloaded"
            />
            <QueueCard
              title="Printed – to ship"
              value={stats.printed}
              tone="warning"
              status="printed"
            />
            <QueueCard
              title="Preparing file"
              value={stats.pending}
              status="pending"
            />
          </InlineGrid>
        </BlockStack>

        <InlineGrid columns={{ xs: 2, sm: 4 }} gap="400">
          <StatCard title="Orders, last 30 days" value={stats.last30Days} />
          <StatCard title="Shipped" value={stats.shipped} />
          <StatCard title="Orders total" value={stats.total} />
          <StatCard title="Designs uploaded" value={stats.totalDesigns} />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Latest orders
                  </Text>
                  <Link to="/app/orders" style={{ textDecoration: "none" }}>
                    <Button variant="plain">View all</Button>
                  </Link>
                </InlineStack>
                {recentOrders.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No orders yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {recentOrders.map((order) => (
                      <Link
                        key={order.id}
                        to={`/app/orders/${order.id}`}
                        style={{ textDecoration: "none", color: "inherit" }}
                      >
                        <Box
                          padding="300"
                          background="bg-surface-secondary"
                          borderRadius="200"
                        >
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="100">
                              <Text as="span" variant="bodyMd" fontWeight="bold">
                                {orderLabel(order)}
                                {order.customerName ? ` · ${order.customerName}` : ""}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {order.widthMm / 10} × {order.heightMm / 10} cm ·{" "}
                                {order._count.images} designs · {order.filmType}
                              </Text>
                            </BlockStack>
                            <StatusBadge status={order.status} />
                          </InlineStack>
                        </Box>
                      </Link>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Popular sizes
                </Text>
                {sizeCounts.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No data yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {sizeCounts.map((sc: any) => (
                      <InlineStack
                        key={`${sc.widthMm}x${sc.heightMm}`}
                        align="space-between"
                      >
                        <Text as="span" variant="bodyMd">
                          {sc.widthMm / 10} × {sc.heightMm / 10} cm
                        </Text>
                        <Badge>{`${sc._count}`}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

/** A queue count that jumps straight to the matching filtered list. */
function QueueCard({
  title,
  value,
  tone,
  status,
}: {
  title: string;
  value: number;
  tone?: "success" | "warning";
  status: string;
}) {
  return (
    <Link
      to={`/app/orders?status=${status}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <StatCard title={title} value={value} tone={value > 0 ? tone : undefined} />
    </Link>
  );
}

function StatCard({
  title,
  value,
  tone,
  large,
}: {
  title: string;
  value: number | string;
  tone?: "success" | "warning";
  large?: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {title}
        </Text>
        <Text
          as="p"
          variant={large ? "heading2xl" : "headingXl"}
          fontWeight="bold"
          tone={tone === "warning" ? "caution" : tone}
        >
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { tone, label } = statusInfo(status);
  return <Badge tone={tone}>{label}</Badge>;
}

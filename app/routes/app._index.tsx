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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [
    total,
    pending,
    exported,
    downloaded,
    printed,
    last30Days,
    totalDesigns,
    revenueResult,
  ] = await Promise.all([
    prisma.gangSheet.count({
      where: { shopDomain, shopifyOrderId: { not: null } },
    }),
    prisma.gangSheet.count({ where: { shopDomain, status: "pending" } }),
    prisma.gangSheet.count({ where: { shopDomain, status: "exported" } }),
    prisma.gangSheet.count({ where: { shopDomain, status: "downloaded" } }),
    prisma.gangSheet.count({ where: { shopDomain, status: "printed" } }),
    prisma.gangSheet.count({
      where: {
        shopDomain,
        shopifyOrderId: { not: null },
        createdAt: { gte: thirtyDaysAgo },
      },
    }),
    prisma.gangSheetImage.count({
      where: { gangSheet: { shopDomain } },
    }),
    prisma.gangSheet.aggregate({
      where: { shopDomain, shopifyOrderId: { not: null } },
      _sum: { priceSEK: true },
      _avg: { priceSEK: true },
    }),
  ]);

  // Popular sheet sizes
  const sizeCounts = await prisma.gangSheet.groupBy({
    by: ["widthMm", "heightMm"],
    where: { shopDomain, shopifyOrderId: { not: null } },
    _count: true,
    orderBy: { _count: { id: "desc" } },
    take: 5,
  });

  // Recent orders
  const recentOrders = await prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { _count: { select: { images: true } } },
  });

  const totalRevenue = revenueResult._sum.priceSEK || 0;
  const avgPrice = Math.round(revenueResult._avg.priceSEK || 0);

  return json({
    stats: {
      total,
      pending,
      exported,
      downloaded,
      printed,
      last30Days,
      totalDesigns,
      totalRevenue,
      avgPrice,
    },
    sizeCounts,
    recentOrders,
  });
};

export default function DashboardIndex() {
  const { stats, sizeCounts, recentOrders } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Gang Sheet Builder — Dashboard" />
      <BlockStack gap="500">
        {/* Key Metrics */}
        <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }} gap="400">
          <StatCard title="Totalt ordrar" value={stats.total} />
          <StatCard title="Senaste 30 dagar" value={stats.last30Days} />
          <StatCard
            title="Väntar"
            value={stats.pending}
            tone="warning"
          />
          <StatCard
            title="Redo"
            value={stats.exported}
            tone="success"
          />
          <StatCard title="Utskrivna" value={stats.printed} />
        </InlineGrid>

        {/* Revenue + Designs */}
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <StatCard
            title="Total intäkt"
            value={`${stats.totalRevenue} kr`}
            large
          />
          <StatCard
            title="Snittorder"
            value={`${stats.avgPrice} kr`}
            large
          />
          <StatCard
            title="Uppladdade designs"
            value={stats.totalDesigns}
            large
          />
        </InlineGrid>

        <Layout>
          {/* Recent Orders */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Senaste ordrar
                  </Text>
                  <Link to="/app/orders" style={{ textDecoration: "none" }}>
                    <Button variant="plain">Visa alla</Button>
                  </Link>
                </InlineStack>
                {recentOrders.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Inga ordrar ännu.
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
                          <InlineStack align="space-between">
                            <BlockStack gap="100">
                              <Text
                                as="span"
                                variant="bodyMd"
                                fontWeight="bold"
                              >
                                {order.shopifyOrderId
                                  ? `Order #${order.shopifyOrderId}`
                                  : `Gang Sheet ${order.id.slice(0, 8)}`}
                              </Text>
                              <Text
                                as="span"
                                variant="bodySm"
                                tone="subdued"
                              >
                                {order.widthMm / 10} x {order.heightMm / 10}{" "}
                                cm | {order._count.images} designs |{" "}
                                {order.filmType} |{" "}
                                {order.priceSEK ? `${order.priceSEK} kr` : "–"}
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

          {/* Popular Sizes */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Populära storlekar
                </Text>
                {sizeCounts.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Ingen data ännu.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {sizeCounts.map((sc: any) => (
                      <InlineStack
                        key={`${sc.widthMm}x${sc.heightMm}`}
                        align="space-between"
                      >
                        <Text as="span" variant="bodyMd">
                          {sc.widthMm / 10} x {sc.heightMm / 10} cm
                        </Text>
                        <Badge>{sc._count} st</Badge>
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
          tone={tone}
        >
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    draft: { tone: undefined, label: "Utkast" },
    pending: { tone: "attention", label: "Väntar" },
    exported: { tone: "success", label: "Exporterad" },
    downloaded: { tone: "info", label: "Nedladdad" },
    printed: { tone: undefined, label: "Utskriven" },
  };
  const { tone, label } = map[status] || { tone: undefined, label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

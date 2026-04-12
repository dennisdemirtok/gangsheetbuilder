import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const where = { shopDomain, shopifyOrderId: { not: null } };

  // Total orders
  const totalOrders = await prisma.gangSheet.count({ where });

  // Average price
  const avgPrice = await prisma.gangSheet.aggregate({
    where,
    _avg: { priceSEK: true },
  });

  // Orders by size
  const ordersBySize = await prisma.gangSheet.groupBy({
    by: ["widthMm", "heightMm"],
    where,
    _count: true,
    orderBy: { _count: { id: "desc" } },
  });

  // Orders by film type
  const ordersByFilm = await prisma.gangSheet.groupBy({
    by: ["filmType"],
    where,
    _count: true,
    orderBy: { _count: { id: "desc" } },
  });

  // Average images per sheet
  const avgImages = await prisma.gangSheet.aggregate({
    where,
    _avg: { imagesCount: true },
  });

  // Orders last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentOrderCount = await prisma.gangSheet.count({
    where: { ...where, createdAt: { gte: thirtyDaysAgo } },
  });

  // Total revenue
  const totalRevenue = await prisma.gangSheet.aggregate({
    where,
    _sum: { priceSEK: true },
  });

  return json({
    totalOrders,
    avgPrice: Math.round(avgPrice._avg.priceSEK || 0),
    avgImages: Math.round(avgImages._avg.imagesCount || 0),
    recentOrderCount,
    totalRevenue: totalRevenue._sum.priceSEK || 0,
    ordersBySize: ordersBySize.map((s) => ({
      size: `${s.widthMm / 10}×${s.heightMm / 10} cm`,
      count: s._count,
    })),
    ordersByFilm: ordersByFilm.map((f) => ({
      film: f.filmType,
      count: f._count,
    })),
  });
};

export default function StatisticsPage() {
  const {
    totalOrders,
    avgPrice,
    avgImages,
    recentOrderCount,
    totalRevenue,
    ordersBySize,
    ordersByFilm,
  } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Statistik" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <InlineStack gap="400" wrap>
              <StatCard title="Totalt ordrar" value={String(totalOrders)} />
              <StatCard
                title="Senaste 30 dagar"
                value={String(recentOrderCount)}
              />
              <StatCard title="Snittpris" value={`${avgPrice} kr`} />
              <StatCard
                title="Snitt designs/ark"
                value={String(avgImages)}
              />
              <StatCard
                title="Total omsättning"
                value={`${totalRevenue.toLocaleString("sv-SE")} kr`}
              />
            </InlineStack>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Populära storlekar
                </Text>
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["Storlek", "Antal ordrar"]}
                  rows={ordersBySize.map((s) => [s.size, s.count])}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Filmtyper
                </Text>
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["Filmtyp", "Antal ordrar"]}
                  rows={ordersByFilm.map((f) => [f.film, f.count])}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {title}
        </Text>
        <Text as="p" variant="headingXl" fontWeight="bold">
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  InlineGrid,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { plural, sheetSize } from "../lib/order-status";

/*
 * The business view, next to the dashboard's work view.
 *
 * It used to repeat the dashboard (orders in the last 30 days, popular
 * sizes) and headline "Total revenue" and "Average price" from a field that
 * holds the storefront quote — including VAT for consumers and excluding it
 * for companies — so the sums mixed the two. Shopify's own reports are the
 * place for money. This page counts what the business is priced by: metres
 * of film.
 */

const MONTHS = 6;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const real = { shopDomain, shopifyOrderId: { not: null } };

  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCMonth(since.getUTCMonth() - (MONTHS - 1));

  const [totals, shipped, bySize, byFilm, monthly] = await Promise.all([
    prisma.gangSheet.aggregate({
      where: real,
      _count: { _all: true },
      _sum: { heightMm: true },
      _avg: { imagesCount: true },
    }),
    prisma.gangSheet.count({ where: { ...real, status: "shipped" } }),
    prisma.gangSheet.groupBy({
      by: ["widthMm", "heightMm"],
      where: real,
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 8,
    }),
    prisma.gangSheet.groupBy({
      by: ["filmType"],
      where: real,
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.$queryRaw<{ month: Date; orders: number; mm: number }[]>`
      SELECT date_trunc('month', created_at) AS month,
             count(*)::int AS orders,
             coalesce(sum(height_mm), 0)::int AS mm
      FROM gangsheet_gang_sheet
      WHERE shop_domain = ${shopDomain}
        AND shopify_order_id IS NOT NULL
        AND created_at >= ${since}
      GROUP BY 1
    `,
  ]);

  // Every month in the window, including the empty ones.
  const months = Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(since);
    d.setUTCMonth(since.getUTCMonth() + i);
    const row = monthly.find(
      (m) =>
        new Date(m.month).getUTCFullYear() === d.getUTCFullYear() &&
        new Date(m.month).getUTCMonth() === d.getUTCMonth(),
    );
    return {
      label: d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }),
      orders: row?.orders ?? 0,
      metres: (row?.mm ?? 0) / 1000,
    };
  });

  const orders = totals._count._all;
  const metres = (totals._sum.heightMm ?? 0) / 1000;

  return json({
    kpis: {
      metres,
      orders,
      avgMetres: orders ? metres / orders : 0,
      avgDesigns: totals._avg.imagesCount ?? 0,
      shipped,
    },
    months,
    sizes: bySize.map((s) => ({
      size: sheetSize(s),
      count: s._count._all,
      share: orders ? s._count._all / orders : 0,
    })),
    films: byFilm.map((f) => ({ film: f.filmType, count: f._count._all })),
  });
};

const m = (value: number) =>
  `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} m`;

export default function StatisticsPage() {
  const { kpis, months, sizes, films } = useLoaderData<typeof loader>();
  const maxMetres = Math.max(...months.map((x) => x.metres), 0);

  return (
    <Page title="Statistics" subtitle="All paid orders">
      <TitleBar title="Statistics" />
      <BlockStack gap="400">
        {/* Same strip as the dashboard's queue, so the two pages read alike. */}
        <Card padding="0">
          <InlineGrid columns={{ xs: 2, md: 4 }}>
            <Kpi label="Film ordered" value={m(kpis.metres)} />
            <Kpi label="Orders" value={String(kpis.orders)} />
            <Kpi label="Average order" value={m(kpis.avgMetres)} />
            <Kpi
              label="Shipped"
              value={String(kpis.shipped)}
              hint={`${kpis.avgDesigns.toFixed(1)} designs per sheet on average`}
              last
            />
          </InlineGrid>
        </Card>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    Film per month
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Metres of film on paid orders, last {MONTHS} months
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  {months.map((month) => (
                    <MonthBar key={month.label} {...month} max={maxMetres} />
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Sheet sizes
                  </Text>
                  {sizes.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No orders yet.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {sizes.map((s) => (
                        <Row
                          key={s.size}
                          label={s.size}
                          value={`${plural(s.count, "order")} · ${Math.round(s.share * 100)}%`}
                        />
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Only worth a card once something other than standard film sells. */}
              {films.length > 1 && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Film types
                    </Text>
                    <BlockStack gap="200">
                      {films.map((f) => (
                        <Row key={f.film} label={f.film} value={plural(f.count, "order")} />
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function Kpi({
  label,
  value,
  hint,
  last,
}: {
  label: string;
  value: string;
  hint?: string;
  last?: boolean;
}) {
  return (
    <Box
      padding="400"
      borderInlineEndWidth={last ? undefined : "025"}
      borderColor="border-secondary"
    >
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="heading2xl">
          {value}
        </Text>
        {hint && (
          <Text as="p" variant="bodyXs" tone="subdued">
            {hint}
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

/** One month as a horizontal bar: a single series, so one colour, no legend. */
function MonthBar({
  label,
  orders,
  metres,
  max,
}: {
  label: string;
  orders: number;
  metres: number;
  max: number;
}) {
  const pct = max > 0 ? (metres / max) * 100 : 0;
  const summary = `${label}: ${m(metres)} · ${plural(orders, "order")}`;

  return (
    <div
      title={summary}
      aria-label={summary}
      role="img"
      style={{ display: "grid", gridTemplateColumns: "72px 1fr 150px", alignItems: "center", gap: 12 }}
    >
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <div
        style={{
          height: 20,
          background: "var(--p-color-bg-surface-secondary)",
          borderRadius: 4,
        }}
      >
        {metres > 0 && (
          <div
            style={{
              width: `${Math.max(pct, 1.5)}%`,
              height: "100%",
              background: "var(--p-color-bg-fill-success)",
              borderRadius: 4,
            }}
          />
        )}
      </div>
      <Text as="span" variant="bodySm" alignment="end" tone={metres > 0 ? undefined : "subdued"}>
        {metres > 0 ? `${m(metres)} · ${plural(orders, "order")}` : "—"}
      </Text>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" gap="200">
      <Text as="span" variant="bodyMd">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" tone="subdued">
        {value}
      </Text>
    </InlineStack>
  );
}

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
  Badge,
  Banner,
  Button,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pingRedis } from "../lib/queue.server";
import { EDGE_MARGIN_MM } from "../lib/placement";
import { SHEET_WIDTH_MM } from "../lib/constants";
import { orderLabel, timeAgo } from "../lib/order-status";
import {
  getPickupAddress,
  isBwsTestEnvironment,
  isSimulationEnabled,
  missingPickupConfig,
  PACKAGE_CM,
  PICKUP_TIME,
} from "../lib/bws-shipping.server";

/*
 * What the app is set up to do, and whether it is working.
 *
 * This page used to be a form of prices, film multipliers, a minimum DPI, a
 * gap size, a max file size, a variant-mapping JSON and auto-delete periods.
 * It saved all of them and nothing read any of them: the storefront charges
 * the Shopify variant price, the builder's DPI bands, gap and edge margin are
 * built in, and no cleanup job was ever scheduled. Changing a value did
 * nothing, which is worse than having no setting. The stored values stay in
 * the database untouched; this page now shows the settings that are real.
 */

const PRICING_PRODUCT_HANDLE = "dtf-transfers-by-size";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [redisOk, latestOrder, designCount, fileCount, pricingProduct] =
    await Promise.all([
      pingRedis(),
      prisma.gangSheet.findFirst({
        where: { shopDomain, shopifyOrderId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { orderName: true, shopifyOrderId: true, createdAt: true },
      }),
      prisma.gangSheetImage.count({ where: { gangSheet: { shopDomain } } }),
      prisma.gangSheetExport.count({ where: { gangSheet: { shopDomain } } }),
      admin
        .graphql(
          `#graphql
          query PricingProduct($handle: String!) {
            productByHandle(handle: $handle) { id title variantsCount { count } }
          }`,
          { variables: { handle: PRICING_PRODUCT_HANDLE } },
        )
        .then((r) => r.json())
        .then((b) => b.data?.productByHandle ?? null)
        .catch(() => null),
    ]);

  const pickup = getPickupAddress();

  return json({
    status: {
      database: true, // the queries above would have thrown otherwise
      redis: redisOk,
      storage: Boolean(
        process.env.R2_ACCOUNT_ID &&
          process.env.R2_ACCESS_KEY_ID &&
          process.env.R2_SECRET_ACCESS_KEY,
      ),
      latestOrder: latestOrder
        ? `${orderLabel(latestOrder)} · ${timeAgo(latestOrder.createdAt)}`
        : null,
    },
    pricing: pricingProduct
      ? {
          title: pricingProduct.title as string,
          variants: pricingProduct.variantsCount?.count as number | undefined,
          adminUrl: `shopify://admin/products/${String(pricingProduct.id).split("/").pop()}`,
        }
      : null,
    print: {
      sheetWidthCm: SHEET_WIDTH_MM / 10,
      edgeMarginMm: EDGE_MARGIN_MM,
      readySheetMinPx: Math.round((SHEET_WIDTH_MM / 25.4) * 300),
    },
    shipping: {
      mode: isBwsTestEnvironment()
        ? isSimulationEnabled()
          ? "Test · simulated"
          : "Test environment"
        : "Live",
      live: !isBwsTestEnvironment(),
      pickup: [pickup.name, pickup.address1, [pickup.zip, pickup.city].filter(Boolean).join(" "), pickup.countryCode]
        .filter(Boolean)
        .join(", "),
      contact: [pickup.contact, pickup.phone].filter(Boolean).join(" · "),
      pickupFrom: PICKUP_TIME,
      packageCm: `${PACKAGE_CM.length} × ${PACKAGE_CM.width} × ${PACKAGE_CM.height} cm tube`,
      missing: missingPickupConfig(),
    },
    storage: { designCount, fileCount },
  });
};

export default function SettingsPage() {
  const { status, pricing, print, shipping, storage } =
    useLoaderData<typeof loader>();

  return (
    <Page
      title="Settings"
      subtitle="How the app is set up, and whether it is working"
    >
      <TitleBar title="Settings" />
      <Layout>
        <Layout.AnnotatedSection
          title="Status"
          description="Everything an order passes through, from payment to print file."
        >
          <Card>
            <BlockStack gap="300">
              <StatusRow label="Database" ok={status.database} />
              <StatusRow
                label="Background jobs"
                ok={status.redis}
                problem="Print files are not being generated"
              />
              <StatusRow
                label="File storage"
                ok={status.storage}
                problem="Not configured"
              />
              <Divider />
              <Row
                label="Latest paid order"
                value={status.latestOrder ?? "None received yet"}
              />
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Prices"
          description="Customers pay the price of the Shopify variant they add to the cart. The builder and the ready-sheet upload read the same variants, so the price shown is the price charged."
        >
          <Card>
            {pricing ? (
              <BlockStack gap="300">
                <Row label="Pricing product" value={pricing.title} />
                {pricing.variants !== undefined && (
                  <Row label="Variants" value={String(pricing.variants)} />
                )}
                <InlineStack>
                  <Button url={pricing.adminUrl}>Edit prices in Shopify</Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <Banner tone="warning" title="Pricing product not found">
                <Text as="p" variant="bodySm">
                  {`The builder looks for a product with the handle "${PRICING_PRODUCT_HANDLE}", or the product chosen in the theme block.`}
                </Text>
              </Banner>
            )}
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Print files"
          description="Built into the app so every file the print shop receives is the same."
        >
          <Card>
            <BlockStack gap="300">
              <Row label="Format" value="Transparent PNG, 300 DPI" />
              <Row label="Sheet width" value={`${print.sheetWidthCm} cm`} />
              <Row label="Margin to sheet edge" value={`${print.edgeMarginMm} mm`} />
              <Row
                label="Ready-made sheets"
                value={`At least ${print.readySheetMinPx.toLocaleString("en-GB")} px wide (300 DPI), 1 m minimum`}
              />
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Shipping"
          description="BWS courier pickup at the print shop. Changed in the server variables on Railway."
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="span" variant="bodyMd" tone="subdued">
                  Mode
                </Text>
                <Badge tone={shipping.live ? "success" : "attention"}>
                  {shipping.mode}
                </Badge>
              </InlineStack>
              <Row label="Pickup address" value={shipping.pickup || "—"} />
              {shipping.contact && <Row label="Contact" value={shipping.contact} />}
              <Row label="Pickup from" value={shipping.pickupFrom} />
              <Row label="Package" value={shipping.packageCm} />
              {shipping.missing.length > 0 && (
                <Banner tone="warning">
                  {`Missing: ${shipping.missing.join(", ")}`}
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Stored files"
          description="Customer designs and print files are kept in file storage."
        >
          <Card>
            <BlockStack gap="300">
              <Row label="Uploaded designs" value={storage.designCount.toLocaleString("en-GB")} />
              <Row label="Print files" value={storage.fileCount.toLocaleString("en-GB")} />
              <Text as="p" variant="bodySm" tone="subdued">
                Nothing is deleted automatically, so print files stay available
                for reprints.
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" gap="400" wrap={false}>
      <Text as="span" variant="bodyMd" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" alignment="end">
        {value}
      </Text>
    </InlineStack>
  );
}

function StatusRow({
  label,
  ok,
  problem = "Not working",
}: {
  label: string;
  ok: boolean;
  problem?: string;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <Text as="span" variant="bodyMd" tone="subdued">
        {label}
      </Text>
      <Badge tone={ok ? "success" : "critical"}>{ok ? "Working" : problem}</Badge>
    </InlineStack>
  );
}

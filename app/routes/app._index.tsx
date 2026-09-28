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
  Button,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  orderLabel,
  plural,
  statusInfo,
  timeAgo,
} from "../lib/order-status";
import { withOrderDetails } from "../lib/order-details.server";
import { filmMetres, jobSize, summarizeJobs } from "../lib/print-jobs";
import { jobsOfOrders, listOrders, orderStatusCounts } from "../lib/order-list.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  /*
   * Counted per Shopify order, not per print job: an order with four cut
   * motifs is one order to handle. Only orders that were paid count.
   */
  const real = { shopDomain, shopifyOrderId: { not: null } };

  const [counts, month, shippedThisMonth, upNext] = await Promise.all([
    orderStatusCounts(shopDomain),
    // Film is summed per job: a cut job's motifs use area, not height.
    prisma.gangSheet.findMany({
      where: { ...real, createdAt: { gte: thirtyDaysAgo } },
      select: { shopifyOrderId: true, kind: true, widthMm: true, heightMm: true, lineQuantity: true },
    }),
    prisma.gangSheet.findMany({
      where: { ...real, status: "shipped", shippedAt: { gte: thirtyDaysAgo } },
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
    // What to work on, oldest first: the order they get printed in.
    listOrders({ shopDomain, status: "open", pageSize: 6, oldestFirst: true }),
  ]);

  const jobs = await withOrderDetails(
    admin,
    shopDomain,
    await jobsOfOrders(shopDomain, upNext.rows.map((r) => r.orderId)),
  );

  const now = new Date();
  return json({
    queue: {
      pending: counts.pending ?? 0,
      exported: counts.exported ?? 0,
      downloaded: counts.downloaded ?? 0,
      printed: counts.printed ?? 0,
    },
    month: {
      orders: new Set(month.map((j) => j.shopifyOrderId)).size,
      metres: month.reduce((sum, job) => sum + filmMetres(job), 0),
      shipped: shippedThisMonth.length,
    },
    upNext: upNext.rows.map((row) => {
      const own = jobs.filter((j) => j.shopifyOrderId === row.orderId);
      return {
        id: row.firstId,
        label: orderLabel({ orderName: own[0]?.orderName ?? row.orderName, shopifyOrderId: row.orderId }),
        customerName: own[0]?.customerName ?? row.customerName,
        print: summarizeJobs(own).join(", "),
        size: own.length === 1 ? jobSize(own[0]) : `${own.length} print jobs`,
        filmType: "standard",
        status: row.status,
        age: timeAgo(row.createdAt, now),
      };
    }),
  });
};

/** The steps a paid sheet moves through, in the order the shop works them. */
const STEPS = [
  { status: "pending", title: "Preparing file", hint: "Generated automatically" },
  { status: "exported", title: "Ready to print", hint: "Send to the print shop" },
  { status: "downloaded", title: "With print shop", hint: "Mark as printed when done" },
  { status: "printed", title: "Printed", hint: "Book pickup and ship" },
] as const;

export default function Dashboard() {
  const { queue, month, upNext } = useLoaderData<typeof loader>();
  const toDo = queue.pending + queue.exported + queue.downloaded + queue.printed;

  return (
    <Page
      title="Print queue"
      subtitle={toDo === 0 ? "All caught up" : `${plural(toDo, "order")} to handle`}
    >
      <TitleBar title="Gang Sheet Builder" />
      <BlockStack gap="400">
        {/* One strip, left to right in the order a job moves. Eight equal
            number cards used to give "Designs uploaded" the same weight as
            the orders waiting to be printed. */}
        <Card padding="0">
          <InlineGrid columns={{ xs: 2, md: 4 }}>
            {STEPS.map((step, i) => (
              <QueueStep
                key={step.status}
                index={i + 1}
                title={step.title}
                hint={step.hint}
                status={step.status}
                count={queue[step.status]}
                last={i === STEPS.length - 1}
              />
            ))}
          </InlineGrid>
        </Card>

        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Up next
                  </Text>
                  <Button variant="plain" url="/app/orders">
                    All orders
                  </Button>
                </InlineStack>
              </Box>
              {upNext.length === 0 ? (
                <Box padding="400" paddingBlockStart="0">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Nothing waiting. New orders appear here as soon as they are
                    paid.
                  </Text>
                </Box>
              ) : (
                upNext.map((order) => (
                  <Link
                    key={order.id}
                    to={`/app/orders/${order.id}`}
                    style={{ textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <Box
                      paddingBlock="300"
                      paddingInline="400"
                      borderBlockStartWidth="025"
                      borderColor="border-secondary"
                    >
                      <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd">
                            <Text as="span" fontWeight="semibold">
                              {order.label}
                            </Text>
                            {order.customerName ? ` · ${order.customerName}` : ""}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {[
                              order.print,
                              order.size,
                              order.filmType !== "standard" ? order.filmType : null,
                              order.age,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        </BlockStack>
                        <StatusBadge status={order.status} />
                      </InlineStack>
                    </Box>
                  </Link>
                ))
              )}
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Last 30 days
                </Text>
                <BlockStack gap="200">
                  <Metric label="Orders" value={String(month.orders)} />
                  <Metric
                    label="Film ordered"
                    value={`${month.metres.toLocaleString("en-GB", { maximumFractionDigits: 1 })} m`}
                  />
                  <Metric label="Shipped" value={String(month.shipped)} />
                </BlockStack>
                <InlineStack>
                  <Button variant="plain" url="/app/statistics">
                    View statistics
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

/** One step of the queue strip; opens the order list filtered to it. */
function QueueStep({
  index,
  title,
  hint,
  status,
  count,
  last,
}: {
  index: number;
  title: string;
  hint: string;
  status: string;
  count: number;
  last: boolean;
}) {
  // Only steps that wait on the print shop draw the eye; files being
  // generated need nothing from them.
  const needsAction = count > 0 && status !== "pending";

  return (
    <Link
      to={`/app/orders?status=${status}`}
      style={{ textDecoration: "none", color: "inherit", display: "block", height: "100%" }}
    >
      <Box
        padding="400"
        minHeight="100%"
        background={needsAction ? "bg-surface-success" : undefined}
        borderInlineEndWidth={last ? undefined : "025"}
        borderColor="border-secondary"
      >
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            {`${index}. ${title}`}
          </Text>
          <Text
            as="p"
            variant="heading2xl"
            tone={count === 0 ? "subdued" : needsAction ? "success" : undefined}
          >
            {count}
          </Text>
          <Text as="p" variant="bodyXs" tone="subdued">
            {hint}
          </Text>
        </BlockStack>
      </Box>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between">
      <Text as="span" variant="bodyMd" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" fontWeight="semibold">
        {value}
      </Text>
    </InlineStack>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { tone, label } = statusInfo(status);
  return <Badge tone={tone}>{label}</Badge>;
}

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
  OPEN_STATUSES,
  orderLabel,
  plural,
  statusInfo,
  timeAgo,
} from "../lib/order-status";
import { withOrderDetails } from "../lib/order-details.server";
import { filmMetres, jobSize, printLabel } from "../lib/print-jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  /*
   * Every count is limited to sheets that reached a paid order. The status
   * counters used to include abandoned carts too, so the dashboard showed
   * "Total orders 0" beside "Waiting 4" and the waiting ones led nowhere.
   */
  const real = { shopDomain, shopifyOrderId: { not: null } };

  const [byStatus, month, shippedThisMonth, upNext] =
    await Promise.all([
      prisma.gangSheet.groupBy({
        by: ["status"],
        where: real,
        _count: { _all: true },
      }),
      // Film is summed per job: a cut job's motifs use area, not height.
      prisma.gangSheet.findMany({
        where: { ...real, createdAt: { gte: thirtyDaysAgo } },
        select: { kind: true, widthMm: true, heightMm: true, lineQuantity: true },
      }),
      prisma.gangSheet.count({
        where: { ...real, status: "shipped", shippedAt: { gte: thirtyDaysAgo } },
      }),
      // What to work on, oldest first — the dashboard used to list the
      // newest orders, which is the opposite of the order they get printed.
      prisma.gangSheet.findMany({
        where: { ...real, status: { in: OPEN_STATUSES } },
        orderBy: { createdAt: "asc" },
        take: 6,
        include: { _count: { select: { images: true } } },
      }),
    ]);

  const countOf = (status: string) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  const now = new Date();
  const named = await withOrderDetails(admin, shopDomain, upNext);

  return json({
    queue: {
      pending: countOf("pending"),
      exported: countOf("exported"),
      downloaded: countOf("downloaded"),
      printed: countOf("printed"),
    },
    month: {
      orders: month.length,
      metres: month.reduce((sum, job) => sum + filmMetres(job), 0),
      shipped: shippedThisMonth,
    },
    upNext: named.map((sheet) => ({
      id: sheet.id,
      label: orderLabel(sheet),
      customerName: sheet.customerName,
      print: printLabel(sheet),
      size: jobSize(sheet),
      filmType: sheet.filmType,
      status: sheet.status,
      age: timeAgo(sheet.createdAt, now),
    })),
  });
};

/** The steps a paid sheet moves through, in the order the shop works them. */
const STEPS = [
  { status: "pending", title: "Preparing file", hint: "Generated automatically" },
  { status: "exported", title: "Ready to print", hint: "Download and print" },
  { status: "downloaded", title: "Downloaded", hint: "Mark as printed when done" },
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

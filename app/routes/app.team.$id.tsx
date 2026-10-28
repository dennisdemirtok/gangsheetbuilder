import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Link as PolarisLink,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatDateTime } from "../lib/order-status";
import {
  TEAM_STATUS,
  digitPickList,
  newWaveArticle,
  newWaveOrderText,
  teamStatus,
  type TeamDigit,
  type TeamLogo,
  type TeamShirt,
} from "../lib/team-orders";

/**
 * One team order, in the order the work happens: order the shirts from New
 * Wave (they deliver to the customer), pick the digits from stock, wait for
 * the logos from the print shop, then send digits and logos to the customer.
 */

type Address = Record<string, string | null | undefined>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const order = await prisma.teamOrder.findFirst({ where: { id: params.id, shopDomain: session.shop } });
  if (!order) throw new Response("Not found", { status: 404 });

  const [sheets, config] = await Promise.all([
    prisma.gangSheet.findMany({
      where: { shopDomain: session.shop, shopifyOrderId: order.shopifyOrderId },
      select: { id: true, status: true, shippingStatus: true, trackingNumber: true, trackingUrl: true, pickupDate: true },
    }),
    prisma.appConfig.findUnique({ where: { shopDomain: session.shop }, select: { teamShipTo: true } }),
  ]);
  const shirts = order.shirts as unknown as TeamShirt[];
  const address = (order.shippingAddress as Address | null) || null;

  return json({
    order: {
      id: order.id,
      label: order.orderName || `#${order.shopifyOrderId}`,
      shopifyOrderId: order.shopifyOrderId,
      customerName: order.customerName,
      team: order.team,
      address,
      status: order.status,
      ordered: formatDateTime(order.createdAt),
      newWaveOrderedAt: order.newWaveOrderedAt ? formatDateTime(order.newWaveOrderedAt) : null,
      newWaveReference: order.newWaveReference,
      digitsPackedAt: order.digitsPackedAt ? formatDateTime(order.digitsPackedAt) : null,
      shippedAt: order.shippedAt ? formatDateTime(order.shippedAt) : null,
      trackingNumber: order.trackingNumber,
    },
    shirts,
    newWaveText: newWaveOrderText(shirts, address as Record<string, string | null> | null),
    picks: digitPickList(order.digits as unknown as TeamDigit[]),
    logos: order.logos as unknown as TeamLogo[],
    sheets,
    hasShipTo: Boolean(config?.teamShipTo),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const order = await prisma.teamOrder.findFirst({ where: { id: params.id, shopDomain: session.shop } });
  if (!order) return json({ errors: ["Order not found."] }, { status: 404 });
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) || "").trim();

  const changes: Record<string, unknown> = {};
  switch (field("action")) {
    case "mark_ordered":
      changes.newWaveOrderedAt = new Date();
      changes.newWaveReference = field("reference") || null;
      break;
    case "unmark_ordered":
      changes.newWaveOrderedAt = null;
      changes.newWaveReference = null;
      break;
    case "mark_packed":
      changes.digitsPackedAt = new Date();
      break;
    case "unmark_packed":
      changes.digitsPackedAt = null;
      break;
    case "mark_shipped":
      changes.shippedAt = new Date();
      changes.trackingNumber = field("tracking").replace(/\s+/g, "") || null;
      break;
    case "unmark_shipped":
      changes.shippedAt = null;
      changes.trackingNumber = null;
      break;
    case "cancel":
      changes.status = "cancelled";
      break;
    case "reopen":
      changes.status = "new";
      break;
    default:
      return json({ errors: ["Unknown action."] }, { status: 400 });
  }
  const next = { ...order, ...changes };
  await prisma.teamOrder.update({
    where: { id: order.id },
    data: { ...changes, status: teamStatus(next as typeof order) },
  });
  return json({ success: true });
};

export default function TeamOrderPage() {
  const { order, shirts, newWaveText, picks, logos, sheets, hasShipTo } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; errors?: string[] }>();
  const [reference, setReference] = useState(order.newWaveReference ?? "");
  const [tracking, setTracking] = useState(order.trackingNumber ?? "");
  const [copied, setCopied] = useState(false);
  const busy = fetcher.state !== "idle";
  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "post" });
  const status = TEAM_STATUS[order.status] ?? { label: order.status, tone: undefined };
  const shirtCount = shirts.reduce((n, s) => n + s.quantity, 0);
  const ownParcel = picks.length > 0 || logos.length > 0;
  const a = order.address;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(newWaveText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Page
      backAction={{ content: "Team orders", url: "/app/team" }}
      title={order.label}
      titleMetadata={<Badge tone={status.tone}>{status.label}</Badge>}
      subtitle={[order.customerName, order.team, order.ordered].filter(Boolean).join(" · ")}
      secondaryActions={[
        { content: "Open in Shopify", url: `shopify://admin/orders/${order.shopifyOrderId}` },
        order.status === "cancelled"
          ? { content: "Reopen", onAction: () => submit({ action: "reopen" }) }
          : { content: "Cancel", destructive: true, onAction: () => submit({ action: "cancel" }) },
      ]}
    >
      <TitleBar title={order.label} />
      <Layout>
        {fetcher.data?.errors && (
          <Layout.Section>
            <Banner tone="critical">{fetcher.data.errors.join(" ")}</Banner>
          </Layout.Section>
        )}

        {shirts.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    1. Shirts from New Wave · {shirtCount}
                  </Text>
                  {order.newWaveOrderedAt && <Badge tone="success">{`Ordered ${order.newWaveOrderedAt}`}</Badge>}
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "numeric"]}
                  headings={["Article", "Shirt", "Colour", "Size", "Qty"]}
                  rows={shirts.map((s) => [newWaveArticle(s.sku), s.title, s.color, s.size, s.quantity])}
                />
                <Text as="p" tone="subdued">
                  New Wave delivers straight to the customer. Order on newwave.se with this address as the delivery
                  address.
                </Text>
                <TextField label="Order for New Wave" value={newWaveText} multiline={6} readOnly autoComplete="off" />
                <InlineStack gap="300" blockAlign="center">
                  <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
                  <PolarisLink url="https://www.newwave.se/" target="_blank">
                    Open newwave.se
                  </PolarisLink>
                </InlineStack>
                {order.newWaveOrderedAt ? (
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="span">
                      Ordered {order.newWaveOrderedAt}
                      {order.newWaveReference ? ` · New Wave order ${order.newWaveReference}` : ""}
                    </Text>
                    <Button variant="plain" loading={busy} onClick={() => submit({ action: "unmark_ordered" })}>
                      Undo
                    </Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ minWidth: 220 }}>
                      <TextField label="New Wave order number" value={reference} onChange={setReference} autoComplete="off" />
                    </div>
                    <Button variant="primary" loading={busy} onClick={() => submit({ action: "mark_ordered", reference })}>
                      Mark as ordered
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {picks.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    2. Digits from stock · {picks.reduce((n, p) => n + p.total, 0)}
                  </Text>
                  {order.digitsPackedAt && <Badge tone="success">{`Packed ${order.digitsPackedAt}`}</Badge>}
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", ...Array(10).fill("numeric"), "numeric"]}
                  headings={["Digits", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Total"]}
                  rows={picks.map((p) => [p.group, ...p.counts.map((n) => (n ? n : "–")), p.total])}
                />
                <InlineStack gap="300" blockAlign="center">
                  {order.digitsPackedAt ? (
                    <Button variant="plain" loading={busy} onClick={() => submit({ action: "unmark_packed" })}>
                      Not packed after all
                    </Button>
                  ) : (
                    <Button loading={busy} onClick={() => submit({ action: "mark_packed" })}>
                      Mark as packed
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {logos.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  3. Logos from the print shop · {logos.reduce((n, l) => n + l.quantity, 0)}
                </Text>
                {!hasShipTo && (
                  <Banner tone="warning">
                    No address is saved under Team orders, so this sheet is booked to the customer. Book it to yourself
                    with an extra shipment on the print order.
                  </Banner>
                )}
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric"]}
                  headings={["Logo", "Width", "Placement", "Qty"]}
                  rows={logos.map((l) => [l.label, l.width ?? "", l.placement ?? "", l.quantity])}
                />
                {sheets.map((s) => (
                  <InlineStack key={s.id} gap="200" blockAlign="center">
                    <PolarisLink url={`/app/orders/${s.id}`}>Print order</PolarisLink>
                    <Text as="span" tone="subdued">
                      {[s.status, s.shippingStatus === "booked" && s.pickupDate ? `pickup ${s.pickupDate}` : "", s.trackingNumber ? `tracking ${s.trackingNumber}` : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {ownParcel && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {logos.length > 0 ? "4." : "3."} Send to the customer
                  </Text>
                  {order.shippedAt && <Badge tone="success">{`Sent ${order.shippedAt}`}</Badge>}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {[picks.length ? "the digits" : "", logos.length ? "the logos" : ""].filter(Boolean).join(" and ")} in one
                  parcel from Sweden to:
                </Text>
                {a && (
                  <Text as="p">
                    {[a.name, a.company, a.address1, a.address2, [a.zip, a.city].filter(Boolean).join(" "), a.country]
                      .filter(Boolean)
                      .join(", ")}
                    {a.phone ? ` · ${a.phone}` : ""}
                  </Text>
                )}
                {order.shippedAt ? (
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="span">
                      Sent {order.shippedAt}
                      {order.trackingNumber ? ` · ${order.trackingNumber}` : ""}
                    </Text>
                    <Button variant="plain" loading={busy} onClick={() => submit({ action: "unmark_shipped" })}>
                      Undo
                    </Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ minWidth: 220 }}>
                      <TextField label="Tracking number (optional)" value={tracking} onChange={setTracking} autoComplete="off" />
                    </div>
                    <Button variant="primary" loading={busy} onClick={() => submit({ action: "mark_shipped", tracking })}>
                      Mark as sent
                    </Button>
                  </InlineStack>
                )}
                <Text as="p" tone="subdued" variant="bodySm">
                  This does not email the customer. Fulfil the order in Shopify when you want them to get the tracking.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

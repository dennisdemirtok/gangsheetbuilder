import { useEffect, useState } from "react";
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
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  BWS_SERVICES,
  PICKUP_TIME,
  defaultPickupDate,
  isBwsTestEnvironment,
  serviceLabel,
} from "../lib/bws-shipping.server";
import { sendGarmentsToSupplier } from "../lib/garment-email.server";
import { bookGarmentPickup, markGarmentShipped, sendGarmentTracking } from "../lib/garment-shipment.server";
import {
  GARMENT_PACKAGE_CM,
  GARMENT_PICKUP,
  GARMENT_STATUS,
  SUPPLIER_EMAIL,
  estimateWeightKg,
  garmentPieces,
  itemsBySku,
  type GarmentItem,
} from "../lib/garments";
import { missingMailConfig } from "../lib/mailer.server";
import { formatDateTime } from "../lib/order-status";
import { getPresignedAttachmentUrl } from "../lib/r2.server";
import { saveUrl } from "../lib/save-file";

/**
 * One order's clothes: what Feelgood should prepare, where it goes, and the
 * steps that are theirs and ours. Send to Feelgood → wait for their go-ahead →
 * book the pickup at Printgood → the customer gets the tracking when the
 * courier has been. The print jobs of the same order are not touched here.
 */

type Address = Record<string, string | null | undefined>;

const ORDER_ADDRESS = `#graphql
  query GarmentOrderAddress($id: ID!) {
    order(id: $id) {
      cancelledAt
      email
      phone
      shippingAddress { name company address1 address2 zip city country countryCodeV2 phone }
    }
  }`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  let order = await prisma.garmentOrder.findFirst({ where: { id: params.id, shopDomain: session.shop } });
  if (!order) throw new Response("Not found", { status: 404 });

  // Name and address follow the order in Shopify until the pickup is booked.
  if (!["booked", "shipped", "cancelled"].includes(order.status) && order.shippingStatus !== "booking") {
    try {
      const res = await admin.graphql(ORDER_ADDRESS, { variables: { id: `gid://shopify/Order/${order.shopifyOrderId}` } });
      const data = (await res.json()).data?.order;
      if (data?.cancelledAt) {
        order = await prisma.garmentOrder.update({ where: { id: order.id }, data: { status: "cancelled" } });
      } else if (data?.shippingAddress) {
        const s = data.shippingAddress;
        const next = {
          name: s.name ?? null,
          company: s.company ?? null,
          address1: s.address1 ?? null,
          address2: s.address2 ?? null,
          zip: s.zip ?? null,
          city: s.city ?? null,
          country: s.country ?? null,
          countryCode: s.countryCodeV2 ?? null,
          phone: s.phone ?? data.phone ?? (order.shippingAddress as Address | null)?.phone ?? null,
          email: data.email ?? (order.shippingAddress as Address | null)?.email ?? null,
        };
        if (JSON.stringify(next) !== JSON.stringify(order.shippingAddress)) {
          order = await prisma.garmentOrder.update({
            where: { id: order.id },
            data: { shippingAddress: next, customerName: next.name || order.customerName },
          });
        }
      }
    } catch (error) {
      console.error("[clothes] Could not refresh the address:", error);
    }
  }

  const items = order.items as unknown as GarmentItem[];
  return json({
    order: {
      id: order.id,
      label: order.orderName || `#${order.shopifyOrderId}`,
      shopifyOrderId: order.shopifyOrderId,
      customerName: order.customerName,
      address: (order.shippingAddress as Address | null) || null,
      status: order.status,
      ordered: formatDateTime(order.createdAt),
      sentAt: order.sentToSupplierAt ? formatDateTime(order.sentToSupplierAt) : null,
      sentTo: order.sentToSupplierTo,
      shippingStatus: order.shippingStatus,
      shippingError: order.shippingError,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      pickupDate: order.pickupDate,
      service: serviceLabel(order.shippingService),
      price: order.shippingPrice != null ? `${order.shippingPrice} ${order.shippingCurrency ?? ""}`.trim() : null,
      hasLabel: Boolean(order.shippingLabelKey),
      fulfillmentError: order.fulfillmentError,
      shippedAt: order.shippedAt ? formatDateTime(order.shippedAt) : null,
    },
    items: itemsBySku(items),
    pieces: garmentPieces(items),
    defaults: {
      to: `${SUPPLIER_EMAIL}, dennis@transfercraft.com`,
      weightKg: estimateWeightKg(items),
      pickupDate: defaultPickupDate(),
      packageCm: GARMENT_PACKAGE_CM,
    },
    pickup: GARMENT_PICKUP,
    pickupTime: PICKUP_TIME,
    services: BWS_SERVICES,
    isTest: isBwsTestEnvironment(),
    missingMail: missingMailConfig(),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const order = await prisma.garmentOrder.findFirst({ where: { id: params.id, shopDomain: session.shop } });
  if (!order) return json({ errors: ["Order not found."] }, { status: 404 });

  if (intent === "send") {
    const recipients = String(form.get("to") || "")
      .split(/[,;\s]+/)
      .map((a) => a.trim())
      .filter(Boolean);
    const invalid = recipients.filter((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (recipients.length === 0 || invalid.length > 0 || recipients.length > 5) {
      return json({
        errors: [invalid.length > 0 ? `Not a valid email address: ${invalid.join(", ")}` : "Enter up to five email addresses."],
      });
    }
    const to = [...new Set(recipients)].join(", ");
    const sent = await sendGarmentsToSupplier({
      shopDomain: session.shop,
      id: order.id,
      to,
      message: String(form.get("message") || ""),
    });
    if (!sent.ok) return json({ errors: sent.errors });
    return json({ ok: true, notice: `Sent to ${to}${sent.attachedLabel ? " with the label" : ""}.` });
  }

  if (intent === "book") {
    const num = (name: string) => parseFloat(String(form.get(name) || "").replace(",", "."));
    const pickupDate = String(form.get("pickupDate") || "");
    const service = String(form.get("service") || "");
    const [length, width, height, weight] = [num("length"), num("width"), num("height"), num("weightKg")];
    const result = await bookGarmentPickup({
      shopDomain: session.shop,
      id: order.id,
      pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) ? pickupDate : undefined,
      weightKg: weight > 0 && weight <= 70 ? weight : undefined,
      service: BWS_SERVICES.some((s) => s.code === service) ? service : undefined,
      packageCm: length > 0 && width > 0 && height > 0 ? { length, width, height } : undefined,
    });
    if (!result.ok) return json({ errors: result.errors });
    return json({
      ok: true,
      notice: `Pickup booked${result.trackingNumbers.length ? `: ${result.trackingNumbers.join(", ")}` : ""}. Send the label to Feelgood.`,
    });
  }

  if (intent === "label") {
    if (!order.shippingLabelKey) return json({ errors: ["No label yet."] }, { status: 404 });
    const ext = order.shippingLabelKey.split(".").pop() || "pdf";
    const name = `${(order.orderName || order.shopifyOrderId).replace(/^#/, "")}_garments_label.${ext}`;
    return json({ downloadUrl: await getPresignedAttachmentUrl(order.shippingLabelKey, name) });
  }

  if (intent === "tracking") {
    const result = await sendGarmentTracking(session.shop, order.id);
    return json(result.ok ? { ok: true, notice: "The customer has the tracking." } : { errors: [result.error] });
  }

  if (intent === "shipped") {
    const result = await markGarmentShipped({
      shopDomain: session.shop,
      id: order.id,
      trackingNumber: String(form.get("trackingNumber") || ""),
    });
    return json(result.ok ? { ok: true, notice: "Marked as shipped · the customer has the tracking." } : { errors: [result.error] });
  }

  if (intent === "status") {
    // Undo a step by hand, e.g. Feelgood asked to wait.
    const status = String(form.get("status") || "");
    if (!["new", "sent", "cancelled"].includes(status)) return json({ errors: ["Unknown status."] });
    await prisma.garmentOrder.update({ where: { id: order.id }, data: { status } });
    return json({ ok: true });
  }

  return json({ errors: ["Unknown action."] }, { status: 400 });
};

/** A form whose fetcher shows its result as a toast. */
function useActionFetcher() {
  const fetcher = useFetcher<{ ok?: boolean; notice?: string; errors?: string[]; downloadUrl?: string }>();
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.downloadUrl) saveUrl(fetcher.data.downloadUrl);
    if (fetcher.data.notice) shopify.toast.show(fetcher.data.notice);
    if (fetcher.data.errors) shopify.toast.show(fetcher.data.errors.join(" "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);
  return fetcher;
}

export default function ClothesOrderPage() {
  const { order, items, pieces, defaults, pickup, pickupTime, services, isTest, missingMail } =
    useLoaderData<typeof loader>();
  const status = GARMENT_STATUS[order.status] ?? { label: order.status, tone: undefined };
  const sendFetcher = useActionFetcher();
  const bookFetcher = useActionFetcher();
  const labelFetcher = useActionFetcher();
  const trackingFetcher = useActionFetcher();
  const shippedFetcher = useActionFetcher();
  const statusFetcher = useActionFetcher();

  const [to, setTo] = useState(defaults.to);
  const [message, setMessage] = useState("");
  const [service, setService] = useState(services[0]?.code ?? "");
  const [pickupDate, setPickupDate] = useState(defaults.pickupDate);
  const [weight, setWeight] = useState(String(defaults.weightKg));
  const [size, setSize] = useState(defaults.packageCm);
  const [tracking, setTracking] = useState("");

  const booked = order.shippingStatus === "booked";
  const a = order.address;

  const nextStep =
    order.status === "new"
      ? "Send the clothes to Feelgood (right). They let you know when the garments are ready for pickup."
      : order.status === "sent"
        ? `Waiting for Feelgood to approve the pickup. Sent ${order.sentAt ?? ""}. When they confirm, book the pickup at Printgood (right).`
        : order.status === "booked"
          ? `Pickup booked for ${order.pickupDate} from ${pickupTime} at Printgood. Send the label to Feelgood if you have not; the customer gets the tracking when the courier has been.`
          : order.status === "shipped"
            ? `Shipped ${order.shippedAt ?? ""}. The customer has the tracking.`
            : "Cancelled.";

  return (
    <Page
      backAction={{ content: "Clothes", url: "/app/clothes" }}
      title={`${order.label} · Clothes`}
      titleMetadata={<Badge tone={status.tone}>{status.label}</Badge>}
      subtitle={[order.customerName, `Ordered ${order.ordered}`].filter(Boolean).join(" · ")}
      secondaryActions={[{ content: "Open in Shopify", url: `shopify://admin/orders/${order.shopifyOrderId}` }]}
    >
      <TitleBar title={`${order.label} · Clothes`} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Next step
                </Text>
                <Text as="p">{nextStep}</Text>
                {order.status === "sent" && (
                  <InlineStack>
                    <Button
                      variant="plain"
                      onClick={() => statusFetcher.submit({ intent: "status", status: "new" }, { method: "post" })}
                    >
                      Not sent after all
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            <Card padding="0">
              <BlockStack gap="0">
                <div style={{ padding: "16px 16px 8px" }}>
                  <Text as="h2" variant="headingMd">
                    Clothes ({pieces} {pieces === 1 ? "piece" : "pieces"})
                  </Text>
                </div>
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric"]}
                  headings={["Garment", "Colour / size", "SKU", "Qty"]}
                  rows={items.map((i) => [i.title, i.variantTitle ?? "", i.sku ?? "", i.quantity])}
                  totals={["", "", "", pieces]}
                  showTotalsInFooter
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Ship to
                </Text>
                {a ? (
                  <>
                    <Text as="p" fontWeight="semibold">
                      {a.name || order.customerName || "-"}
                    </Text>
                    {a.company && <Text as="p">{a.company}</Text>}
                    <Text as="p">{a.address1}</Text>
                    {a.address2 && <Text as="p">{a.address2}</Text>}
                    <Text as="p">{[a.zip, a.city].filter(Boolean).join(" ")}</Text>
                    <Text as="p">{a.country}</Text>
                    {a.phone && (
                      <Text as="p" tone="subdued">
                        {a.phone}
                      </Text>
                    )}
                    {a.email && (
                      <Text as="p" tone="subdued">
                        {a.email}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text as="p" tone="critical">
                    The order has no shipping address.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {order.status !== "cancelled" && order.status !== "shipped" && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Send to Feelgood
                  </Text>
                  <Text as="p" tone="subdued">
                    The clothes, sizes, SKUs and delivery address, in English
                    {booked ? ", with the pickup time and the label" : ""}.
                    {order.sentAt ? ` Last sent ${order.sentAt} to ${order.sentTo}.` : ""}
                  </Text>
                  {missingMail.length > 0 && <Banner tone="warning">Email is not set up: {missingMail.join(", ")}</Banner>}
                  <TextField label="To" value={to} onChange={setTo} autoComplete="off" />
                  <TextField label="Message (optional)" value={message} onChange={setMessage} multiline={3} autoComplete="off" />
                  <Button
                    variant={order.status === "new" || (booked && !!order.sentAt) ? "primary" : undefined}
                    loading={sendFetcher.state !== "idle"}
                    onClick={() => sendFetcher.submit({ intent: "send", to, message }, { method: "post" })}
                  >
                    {order.sentAt ? (booked ? "Send again with the label" : "Send again") : "Send to Feelgood"}
                  </Button>
                </BlockStack>
              </Card>
            )}

            {order.status !== "cancelled" && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Pickup at Printgood
                  </Text>
                  <Text as="p" tone="subdued">
                    {pickup.company} · {pickup.contact} · {pickup.address1}, {pickup.zip} {pickup.city} · {pickup.phone}
                  </Text>
                  {isTest && <Banner tone="info">BWS test environment: bookings are not real.</Banner>}
                  {order.shippingError && order.shippingStatus === "failed" && (
                    <Banner tone="critical">{order.shippingError}</Banner>
                  )}
                  {booked ? (
                    <BlockStack gap="200">
                      <Text as="p">
                        {order.pickupDate} from {pickupTime} · {order.service}
                        {order.price ? ` · ${order.price}` : ""}
                      </Text>
                      {order.trackingNumber && (
                        <Text as="p">
                          Tracking:{" "}
                          {order.trackingUrl ? (
                            <a href={order.trackingUrl} target="_blank" rel="noreferrer">
                              {order.trackingNumber}
                            </a>
                          ) : (
                            order.trackingNumber
                          )}
                        </Text>
                      )}
                      <InlineStack gap="200">
                        {order.hasLabel && (
                          <Button
                            loading={labelFetcher.state !== "idle"}
                            onClick={() => labelFetcher.submit({ intent: "label" }, { method: "post" })}
                          >
                            Download label
                          </Button>
                        )}
                        {order.status === "booked" && (
                          <Button
                            loading={trackingFetcher.state !== "idle"}
                            onClick={() => trackingFetcher.submit({ intent: "tracking" }, { method: "post" })}
                          >
                            Send tracking now
                          </Button>
                        )}
                      </InlineStack>
                      {order.fulfillmentError && <Banner tone="warning">{order.fulfillmentError}</Banner>}
                    </BlockStack>
                  ) : order.status !== "shipped" ? (
                    <BlockStack gap="200">
                      {order.status === "new" && (
                        <Text as="p" tone="caution">
                          Book when Feelgood has said the garments are ready.
                        </Text>
                      )}
                      <Select
                        label="Service"
                        options={services.map((s) => ({ label: s.label, value: s.code }))}
                        value={service}
                        onChange={setService}
                      />
                      <TextField label="Pickup date" type="date" value={pickupDate} onChange={setPickupDate} autoComplete="off" />
                      <TextField label="Weight (kg)" type="number" value={weight} onChange={setWeight} autoComplete="off" />
                      <InlineStack gap="200" wrap={false}>
                        {(["length", "width", "height"] as const).map((k) => (
                          <TextField
                            key={k}
                            label={`${k[0].toUpperCase()}${k.slice(1)} (cm)`}
                            type="number"
                            value={String(size[k])}
                            onChange={(v) => setSize({ ...size, [k]: Number(v) || 0 })}
                            autoComplete="off"
                          />
                        ))}
                      </InlineStack>
                      <Button
                        variant={order.status === "sent" ? "primary" : undefined}
                        loading={bookFetcher.state !== "idle"}
                        onClick={() =>
                          bookFetcher.submit(
                            { intent: "book", service, pickupDate, weightKg: weight, ...Object.fromEntries(Object.entries(size).map(([k, v]) => [k, String(v)])) },
                            { method: "post" },
                          )
                        }
                      >
                        Book pickup
                      </Button>
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>
            )}

            {order.status !== "shipped" && order.status !== "cancelled" && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Shipped another way?
                  </Text>
                  <TextField label="Tracking number" value={tracking} onChange={setTracking} autoComplete="off" />
                  <InlineStack>
                    <Button
                      loading={shippedFetcher.state !== "idle"}
                      disabled={!tracking.trim()}
                      onClick={() => shippedFetcher.submit({ intent: "shipped", trackingNumber: tracking }, { method: "post" })}
                    >
                      Mark as shipped
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

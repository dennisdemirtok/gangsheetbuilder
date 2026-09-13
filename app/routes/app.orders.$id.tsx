import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Button,
  InlineStack,
  Thumbnail,
  Box,
  TextField,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getPresignedDownloadUrl } from "../lib/r2.server";
import { orderLabel, statusInfo } from "../lib/order-status";
import {
  getPickupAddress,
  isBwsTestEnvironment,
  missingPickupConfig,
  PACKAGE_CM,
  PICKUP_TIME,
  isSimulationEnabled,
  SIMULATED_PREFIX,
} from "../lib/bws-shipping.server";
import {
  bookOrderShipment,
  sendTrackingToCustomer,
  summarizeOrderShipment,
} from "../lib/order-shipment.server";
import { BwsShippingCard } from "../components/BwsShippingCard";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const gangSheet = await prisma.gangSheet.findUnique({
    where: { id: params.id },
    include: {
      images: true,
      exports: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!gangSheet || gangSheet.shopDomain !== session.shop) {
    throw new Response("Not found", { status: 404 });
  }

  // Generate presigned download URLs for exports
  const exportsWithUrls = await Promise.all(
    gangSheet.exports.map(async (exp) => ({
      ...exp,
      downloadUrl: await getPresignedDownloadUrl(exp.url),
    })),
  );

  // Generate preview URL
  const previewDownloadUrl = gangSheet.previewUrl
    ? await getPresignedDownloadUrl(gangSheet.previewUrl)
    : null;

  const labelUrl = gangSheet.shippingLabelKey
    ? await getPresignedDownloadUrl(gangSheet.shippingLabelKey)
    : null;

  // BWS booking is per Shopify order, so only sheets that belong to one get it.
  const shipping = gangSheet.shopifyOrderId
    ? {
        summary: await summarizeOrderShipment(
          session.shop,
          gangSheet.shopifyOrderId,
        ),
        pickup: getPickupAddress(),
        pickupFrom: PICKUP_TIME,
        packageCm: { ...PACKAGE_CM },
        missingConfig: missingPickupConfig(),
        isTest: isBwsTestEnvironment(),
        simulation: isSimulationEnabled(),
        simulated: Boolean(gangSheet.bwsBookingId?.startsWith(SIMULATED_PREFIX)),
      }
    : null;

  return json({
    gangSheet,
    exports: exportsWithUrls,
    previewDownloadUrl,
    labelUrl,
    shipping,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

  const gangSheet = await prisma.gangSheet.findUnique({
    where: { id: params.id },
  });

  if (!gangSheet || gangSheet.shopDomain !== session.shop) {
    return json({ error: "Not found" }, { status: 404 });
  }

  if (action === "mark_downloaded") {
    await prisma.gangSheet.update({
      where: { id: params.id },
      data: { status: "downloaded" },
    });
  } else if (action === "mark_printed") {
    await prisma.gangSheet.update({
      where: { id: params.id },
      data: { status: "printed" },
    });
  } else if (action === "mark_shipped") {
    // The status ladder stopped at "printed", so nobody could tell a sheet
    // waiting to go out from one already on its way to the customer.
    const tracking = String(formData.get("trackingNumber") || "").trim();
    await prisma.gangSheet.update({
      where: { id: params.id },
      data: {
        status: "shipped",
        shippedAt: new Date(),
        trackingNumber: tracking || null,
      },
    });
  } else if (action === "book_bws") {
    if (!gangSheet.shopifyOrderId) {
      return json({ errors: ["This sheet is not part of an order."] }, { status: 400 });
    }
    const weight = parseFloat(String(formData.get("weightKg") || ""));
    const pickupDate = String(formData.get("pickupDate") || "");
    const result = await bookOrderShipment({
      shopDomain: session.shop,
      shopifyOrderId: gangSheet.shopifyOrderId,
      pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) ? pickupDate : undefined,
      weightKg: weight > 0 && weight <= 30 ? weight : undefined,
    });
    return json(result.ok ? { success: true } : { errors: result.errors });
  } else if (action === "send_tracking") {
    if (!gangSheet.shopifyOrderId) {
      return json({ errors: ["This sheet is not part of an order."] }, { status: 400 });
    }
    const result = await sendTrackingToCustomer(session.shop, gangSheet.shopifyOrderId);
    return json(result.ok ? { success: true } : { errors: [result.error] });
  } else if (action === "add_note") {
    const body = String(formData.get("body") || "").trim();
    if (body) {
      await prisma.gangSheetNote.create({
        data: {
          gangSheetId: params.id!,
          author: session.shop,
          body: body.slice(0, 2000),
        },
      });
    }
  }

  return json({ success: true });
};

interface ShippingAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

export default function OrderDetailPage() {
  const {
    gangSheet,
    exports: exportFiles,
    previewDownloadUrl,
    labelUrl,
    shipping,
  } = useLoaderData<typeof loader>();
  const address = (gangSheet.shippingAddress as ShippingAddress | null) || null;
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const status = statusInfo(gangSheet.status);

  const designRows = gangSheet.images.map((img) => [
    img.originalFilename,
    `${img.widthPx} × ${img.heightPx}`,
    img.dpiX ? String(img.dpiX) : "—",
    img.displayWidth
      ? `${(img.displayWidth / 10).toFixed(1)} × ${((img.displayHeight ?? 0) / 10).toFixed(1)} cm`
      : "—",
    img.quantity,
  ]);

  return (
    <Page
      backAction={{ content: "Orders", url: "/app/orders" }}
      title={orderLabel(gangSheet)}
      subtitle={gangSheet.customerName || undefined}
      titleMetadata={<Badge tone={status.tone}>{status.label}</Badge>}
    >
      <TitleBar title={orderLabel(gangSheet)} />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            {/* The single thing to do next. The page used to offer every
                status button at once, leaving the shop to work out which
                one applied. */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Next step
                  </Text>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  {status.hint}
                </Text>

                {(gangSheet.status === "exported" ||
                  gangSheet.status === "downloaded") && (
                  <InlineStack gap="200">
                    {exportFiles[0] && (
                      <Button url={exportFiles[0].downloadUrl} external>
                        Download print file
                      </Button>
                    )}
                    <fetcher.Form method="post">
                      <input type="hidden" name="action" value="mark_printed" />
                      <Button submit variant="primary" loading={busy}>
                        Mark as printed
                      </Button>
                    </fetcher.Form>
                  </InlineStack>
                )}

                {gangSheet.status === "printed" && (
                  <fetcher.Form method="post">
                    <input type="hidden" name="action" value="mark_shipped" />
                    <BlockStack gap="200">
                      <TextField
                        label="Tracking number"
                        name="trackingNumber"
                        autoComplete="off"
                        helpText="Optional, but the customer will want it."
                      />
                      <InlineStack>
                        <Button submit variant="primary" loading={busy}>
                          Mark as shipped
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </fetcher.Form>
                )}

                {gangSheet.status === "shipped" && (
                  <BlockStack gap="100">
                    {gangSheet.shippedAt && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Shipped{" "}
                        {new Date(gangSheet.shippedAt).toLocaleString("en-GB")}
                      </Text>
                    )}
                    {gangSheet.trackingNumber && (
                      <Text as="p" variant="bodySm">
                        Tracking: {gangSheet.trackingNumber}
                      </Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Preview
                </Text>
                {previewDownloadUrl ? (
                  <Box>
                    <img
                      src={previewDownloadUrl}
                      alt="Gang sheet preview"
                      style={{
                        maxWidth: "100%",
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        background:
                          "repeating-conic-gradient(#f1f1f1 0% 25%, #fff 0% 50%) 50%/16px 16px",
                      }}
                    />
                  </Box>
                ) : (
                  <Banner tone="info">
                    The preview appears once the print file has been generated.
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Designs on this sheet
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text", "numeric"]}
                  headings={["File", "Pixels", "DPI", "Printed size", "Copies"]}
                  rows={designRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Ship to
                </Text>
                {address ? (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {address.name || gangSheet.customerName || "—"}
                    </Text>
                    {address.company && (
                      <Text as="p" variant="bodySm">{address.company}</Text>
                    )}
                    <Text as="p" variant="bodySm">{address.address1}</Text>
                    {address.address2 && (
                      <Text as="p" variant="bodySm">{address.address2}</Text>
                    )}
                    <Text as="p" variant="bodySm">
                      {[address.zip, address.city].filter(Boolean).join(" ")}
                    </Text>
                    <Text as="p" variant="bodySm">{address.country}</Text>
                    {address.phone && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {address.phone}
                      </Text>
                    )}
                    {address.email && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {address.email}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No shipping address saved for this order.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {shipping && (
              <BwsShippingCard
                sheet={gangSheet}
                shipping={shipping}
                labelUrl={labelUrl}
              />
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Print file
                </Text>
                {exportFiles.length > 0 ? (
                  <BlockStack gap="200">
                    {exportFiles.map((exp) => (
                      <Button key={exp.id} url={exp.downloadUrl} external fullWidth>
                        {`Download ${exp.format.toUpperCase()}${
                          exp.fileSizeBytes
                            ? ` (${(exp.fileSizeBytes / 1024 / 1024).toFixed(1)} MB)`
                            : ""
                        }`}
                      </Button>
                    ))}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`300 DPI · ${gangSheet.widthMm / 10} × ${gangSheet.heightMm / 10} cm`}
                    </Text>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Not generated yet.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Details
                </Text>
                <DetailRow
                  label="Size"
                  value={`${gangSheet.widthMm / 10} × ${gangSheet.heightMm / 10} cm`}
                />
                <DetailRow label="Film" value={gangSheet.filmType} />
                <DetailRow label="Designs" value={String(gangSheet.imagesCount)} />
                <DetailRow
                  label="Ordered"
                  value={new Date(gangSheet.createdAt).toLocaleString("en-GB")}
                />
              </BlockStack>
            </Card>

            {/* Notes — somewhere for the print shop and the store to talk
                about a job without leaving the app. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Notes
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="action" value="add_note" />
                  <BlockStack gap="200">
                    <TextField
                      label="New note"
                      labelHidden
                      name="body"
                      multiline={3}
                      autoComplete="off"
                      placeholder="e.g. Reprinted because of a colour issue"
                    />
                    <InlineStack>
                      <Button submit loading={busy}>
                        Add note
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </fetcher.Form>

                {gangSheet.notes.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No notes yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {gangSheet.notes.map((note) => (
                      <Box
                        key={note.id}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodySm">
                            {note.body}
                          </Text>
                          <Text as="p" variant="bodyXs" tone="subdued">
                            {new Date(note.createdAt).toLocaleString("en-GB")}
                          </Text>
                        </BlockStack>
                      </Box>
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodySm">
        {value}
      </Text>
    </InlineStack>
  );
}

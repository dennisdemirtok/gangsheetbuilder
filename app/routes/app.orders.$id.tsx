import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Button,
  InlineStack,
  Box,
  TextField,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getPresignedAttachmentUrl,
  getPresignedDownloadUrl,
} from "../lib/r2.server";
import {
  formatDateTime,
  orderLabel,
  printFileName,
  sheetSize,
  statusInfo,
} from "../lib/order-status";
import { withOrderDetails } from "../lib/order-details.server";
import { saveUrl } from "../lib/save-file";
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
  const { session, admin } = await authenticate.admin(request);

  const found = await prisma.gangSheet.findUnique({
    where: { id: params.id },
    include: {
      images: true,
      exports: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!found || found.shopDomain !== session.shop) {
    throw new Response("Not found", { status: 404 });
  }

  const [[gangSheet], previewUrl, summary] = await Promise.all([
    withOrderDetails(admin, session.shop, [found]),
    found.previewUrl ? getPresignedDownloadUrl(found.previewUrl) : null,
    // BWS booking is per Shopify order, so only sheets that belong to one get it.
    found.shopifyOrderId
      ? summarizeOrderShipment(session.shop, found.shopifyOrderId)
      : null,
  ]);

  const shipping = summary
    ? {
        summary,
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
    orderedAt: formatDateTime(gangSheet.createdAt),
    previewUrl,
    hasLabel: Boolean(gangSheet.shippingLabelKey),
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

  if (action === "download") {
    /*
     * The link is made at click time rather than on page load: a presigned
     * URL rendered into the page expired after an hour, and a print shop
     * leaves an order open far longer than that.
     */
    if (formData.get("kind") === "label") {
      if (!gangSheet.shippingLabelKey) {
        return json({ error: "No label" }, { status: 404 });
      }
      const ext = gangSheet.shippingLabelKey.split(".").pop() || "pdf";
      const name = `${orderLabel(gangSheet).replace(/^#/, "")}_label.${ext}`;
      return json({
        downloadUrl: await getPresignedAttachmentUrl(gangSheet.shippingLabelKey, name),
      });
    }

    const exportId = String(formData.get("exportId") || "");
    const file = await prisma.gangSheetExport.findFirst({
      where: { gangSheetId: gangSheet.id, ...(exportId ? { id: exportId } : {}) },
      orderBy: { createdAt: "desc" },
    });
    if (!file) return json({ error: "No print file yet" }, { status: 404 });

    // Downloading is the step itself — the shop should not have to report it.
    if (gangSheet.status === "exported") {
      await prisma.gangSheet.update({
        where: { id: gangSheet.id },
        data: { status: "downloaded" },
      });
    }
    return json({
      downloadUrl: await getPresignedAttachmentUrl(
        file.url,
        printFileName(gangSheet, file.format),
      ),
    });
  }

  if (action === "mark_printed") {
    await prisma.gangSheet.update({
      where: { id: params.id },
      data: { status: "printed" },
    });
  } else if (action === "mark_shipped") {
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
  const { gangSheet, orderedAt, previewUrl, hasLabel, shipping } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const address = (gangSheet.shippingAddress as ShippingAddress | null) || null;
  const status = statusInfo(gangSheet.status);
  const latestFile = gangSheet.exports[0];

  // Separate fetchers, so downloading does not spin the status buttons.
  const statusFetcher = useFetcher();
  const noteFetcher = useFetcher<{ success?: boolean }>();
  const downloadFetcher = useFetcher<{ downloadUrl?: string; error?: string }>();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const revalidator = useRevalidator();

  const download = (kind: "file" | "label", exportId?: string) => {
    setDownloading(kind);
    downloadFetcher.submit(
      { action: "download", kind, ...(exportId ? { exportId } : {}) },
      { method: "post" },
    );
  };

  useEffect(() => {
    if (downloadFetcher.state !== "idle" || !downloadFetcher.data) return;
    if (downloadFetcher.data.downloadUrl) {
      saveUrl(downloadFetcher.data.downloadUrl);
    } else if (downloadFetcher.data.error) {
      shopify.toast.show(downloadFetcher.data.error, { isError: true });
    }
    setDownloading(null);
  }, [downloadFetcher.state, downloadFetcher.data, shopify]);

  useEffect(() => {
    if (noteFetcher.state === "idle" && noteFetcher.data?.success) setNote("");
  }, [noteFetcher.state, noteFetcher.data]);

  // While the file is generated, check back so the page moves on by itself.
  useEffect(() => {
    if (gangSheet.status !== "pending") return;
    const t = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gangSheet.status]);

  const statusBusy = statusFetcher.state !== "idle";
  const fileMeta = [
    sheetSize(gangSheet),
    "300 DPI",
    gangSheet.filmType === "standard" ? "standard film" : gangSheet.filmType,
    latestFile?.fileSizeBytes
      ? `${latestFile.format.toUpperCase()} ${(latestFile.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
      titleMetadata={<Badge tone={status.tone}>{status.label}</Badge>}
      subtitle={[gangSheet.customerName, `Ordered ${orderedAt}`]
        .filter(Boolean)
        .join(" · ")}
      secondaryActions={
        gangSheet.shopifyOrderId
          ? [
              {
                content: "Open in Shopify",
                url: `shopify://admin/orders/${gangSheet.shopifyOrderId}`,
              },
            ]
          : undefined
      }
    >
      <TitleBar title={orderLabel(gangSheet)} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* The single thing to do next, with the button for it. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Next step
                </Text>
                <Text as="p" variant="bodyMd">
                  {status.hint}
                </Text>

                {gangSheet.status === "exported" && latestFile && (
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      onClick={() => download("file")}
                      loading={downloading === "file"}
                    >
                      Download print file
                    </Button>
                    <statusFetcher.Form method="post">
                      <input type="hidden" name="action" value="mark_printed" />
                      <Button submit loading={statusBusy}>
                        Mark as printed
                      </Button>
                    </statusFetcher.Form>
                  </InlineStack>
                )}

                {gangSheet.status === "downloaded" && (
                  <InlineStack gap="200">
                    <statusFetcher.Form method="post">
                      <input type="hidden" name="action" value="mark_printed" />
                      <Button submit variant="primary" loading={statusBusy}>
                        Mark as printed
                      </Button>
                    </statusFetcher.Form>
                    {latestFile && (
                      <Button
                        onClick={() => download("file")}
                        loading={downloading === "file"}
                      >
                        Download again
                      </Button>
                    )}
                  </InlineStack>
                )}

                {gangSheet.status === "printed" && (
                  <statusFetcher.Form method="post">
                    <input type="hidden" name="action" value="mark_shipped" />
                    <BlockStack gap="200">
                      <TextField
                        label="Tracking number"
                        name="trackingNumber"
                        autoComplete="off"
                        helpText="Not needed if the shipment was booked with BWS."
                      />
                      <InlineStack>
                        <Button submit variant="primary" loading={statusBusy}>
                          Mark as shipped
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </statusFetcher.Form>
                )}

                {gangSheet.status === "shipped" && (
                  <BlockStack gap="100">
                    {gangSheet.shippedAt && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Shipped {formatDateTime(gangSheet.shippedAt)}
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

            {/* The file and what it looks like, together. The preview used to
                fill the whole screen with a separate card for the download
                and another for the size. */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Print file
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {fileMeta}
                    </Text>
                  </BlockStack>
                  {latestFile && (
                    <Button
                      onClick={() => download("file")}
                      loading={downloading === "file"}
                    >
                      Download
                    </Button>
                  )}
                </InlineStack>
                {previewUrl ? (
                  <Box
                    borderRadius="200"
                    borderWidth="025"
                    borderColor="border"
                    padding="300"
                  >
                    <div
                      style={{
                        background:
                          "repeating-conic-gradient(#f1f1f1 0% 25%, #fff 0% 50%) 50%/16px 16px",
                        borderRadius: 6,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <img
                        src={previewUrl}
                        alt={`Preview of ${orderLabel(gangSheet)}`}
                        style={{ maxWidth: "100%", maxHeight: 380, display: "block" }}
                      />
                    </div>
                  </Box>
                ) : (
                  <Banner tone="info">
                    The file is being generated. This page updates when it is
                    ready.
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <Text as="h2" variant="headingMd">
                  Designs on this sheet
                </Text>
              </Box>
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "numeric"]}
                headings={["File", "Pixels", "DPI", "Printed size", "Copies"]}
                rows={designRows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
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
                    {address.company && <Text as="p" variant="bodyMd">{address.company}</Text>}
                    <Text as="p" variant="bodyMd">{address.address1}</Text>
                    {address.address2 && <Text as="p" variant="bodyMd">{address.address2}</Text>}
                    <Text as="p" variant="bodyMd">
                      {[address.zip, address.city].filter(Boolean).join(" ")}
                    </Text>
                    <Text as="p" variant="bodyMd">{address.country}</Text>
                    {(address.phone || address.email) && (
                      <Box paddingBlockStart="100">
                        {address.phone && (
                          <Text as="p" variant="bodySm" tone="subdued">{address.phone}</Text>
                        )}
                        {address.email && (
                          <Text as="p" variant="bodySm" tone="subdued">{address.email}</Text>
                        )}
                      </Box>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No shipping address on this order.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {shipping && (
              <BwsShippingCard
                sheet={gangSheet}
                shipping={shipping}
                hasLabel={hasLabel}
                onDownloadLabel={() => download("label")}
                downloadingLabel={downloading === "label"}
              />
            )}

            {/* Notes — somewhere for the print shop and the store to talk
                about a job without leaving the app. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Notes
                </Text>
                {gangSheet.notes.length > 0 && (
                  <BlockStack gap="200">
                    {gangSheet.notes.map((n) => (
                      <Box
                        key={n.id}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd">
                            {n.body}
                          </Text>
                          <Text as="p" variant="bodyXs" tone="subdued">
                            {formatDateTime(n.createdAt)}
                          </Text>
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
                <noteFetcher.Form method="post">
                  <input type="hidden" name="action" value="add_note" />
                  <BlockStack gap="200">
                    <TextField
                      label="New note"
                      labelHidden
                      name="body"
                      value={note}
                      onChange={setNote}
                      multiline={2}
                      autoComplete="off"
                      placeholder="e.g. Reprinted because of a colour issue"
                    />
                    <InlineStack>
                      <Button submit disabled={!note.trim()} loading={noteFetcher.state !== "idle"}>
                        Add note
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </noteFetcher.Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

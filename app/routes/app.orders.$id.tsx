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

  return json({
    gangSheet,
    exports: exportsWithUrls,
    previewDownloadUrl,
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
  const { gangSheet, exports: exportFiles, previewDownloadUrl } =
    useLoaderData<typeof loader>();
  const address = (gangSheet.shippingAddress as ShippingAddress | null) || null;
  const fetcher = useFetcher();

  const dpiRows = gangSheet.images.map((img) => [
    img.originalFilename,
    `${img.widthPx} × ${img.heightPx}`,
    img.dpiX ? String(img.dpiX) : "-",
    img.displayWidth
      ? `${img.displayWidth.toFixed(1)} × ${img.displayHeight?.toFixed(1)} mm`
      : "-",
    img.quantity,
    img.bgRemoved ? "Ja" : "Nej",
  ]);

  return (
    <Page
      backAction={{ content: "Ordrar", url: "/app/orders" }}
      title={`Order #${gangSheet.shopifyOrderId || gangSheet.id.slice(0, 8)}`}
      titleMetadata={<StatusBadge status={gangSheet.status} />}
    >
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            {/* Preview */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Förhandsvisning
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
                      }}
                    />
                  </Box>
                ) : (
                  <Banner tone="warning">
                    Ingen förhandsvisning tillgänglig ännu.
                  </Banner>
                )}
              </BlockStack>
            </Card>

            {/* Image details */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Designs ({gangSheet.images.length})
                </Text>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "text",
                  ]}
                  headings={[
                    "Fil",
                    "Original (px)",
                    "DPI",
                    "Storlek på ark",
                    "Antal",
                    "Bg borttagen",
                  ]}
                  rows={dpiRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            {/* Who and where to send it — the page had neither, so a sheet
                could be printed but not posted without leaving the app. */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Mottagare
                </Text>
                {address ? (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {address.name || gangSheet.customerName || "-"}
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
                    Ingen leveransadress sparad för den här ordern.
                  </Text>
                )}
                {gangSheet.orderName && (
                  <DetailRow label="Order" value={gangSheet.orderName} />
                )}
              </BlockStack>
            </Card>

            {/* Info */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Detaljer
                </Text>
                <DetailRow
                  label="Storlek"
                  value={`${gangSheet.widthMm / 10} × ${gangSheet.heightMm / 10} cm`}
                />
                <DetailRow label="Filmtyp" value={gangSheet.filmType} />
                <DetailRow
                  label="Pris"
                  value={
                    gangSheet.priceSEK ? `${gangSheet.priceSEK} kr` : "-"
                  }
                />
                <DetailRow
                  label="Designs"
                  value={String(gangSheet.imagesCount)}
                />
                <DetailRow
                  label="Skapad"
                  value={new Date(gangSheet.createdAt).toLocaleString("sv-SE")}
                />
              </BlockStack>
            </Card>

            {/* Download */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Nedladdning
                </Text>
                {exportFiles.length > 0 ? (
                  <BlockStack gap="200">
                    {exportFiles.map((exp) => (
                      <Button
                        key={exp.id}
                        url={exp.downloadUrl}
                        fullWidth
                      >
                        Ladda ner {exp.format.toUpperCase()}
                        {exp.fileSizeBytes
                          ? ` (${(exp.fileSizeBytes / 1024 / 1024).toFixed(1)} MB)`
                          : ""}
                      </Button>
                    ))}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Export pågår eller saknas.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {/* Status actions */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Uppdatera status
                </Text>
                <InlineStack gap="200">
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="action"
                      value="mark_downloaded"
                    />
                    <Button
                      submit
                      disabled={gangSheet.status === "downloaded"}
                    >
                      Markera nedladdad
                    </Button>
                  </fetcher.Form>
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="action"
                      value="mark_printed"
                    />
                    <Button
                      submit
                      disabled={gangSheet.status === "printed"}
                    >
                      Markera utskriven
                    </Button>
                  </fetcher.Form>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Shipping. The status ladder used to stop at "printed", so a
                sheet waiting to go out looked the same as one on its way. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Frakt
                </Text>
                {gangSheet.status === "shipped" ? (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Skickad
                      {gangSheet.shippedAt
                        ? ` ${new Date(gangSheet.shippedAt).toLocaleDateString("sv-SE")}`
                        : ""}
                    </Text>
                    {gangSheet.trackingNumber && (
                      <Text as="p" variant="bodySm">
                        Spårning: {gangSheet.trackingNumber}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <fetcher.Form method="post">
                    <input type="hidden" name="action" value="mark_shipped" />
                    <BlockStack gap="200">
                      <TextField
                        label="Spårningsnummer"
                        name="trackingNumber"
                        autoComplete="off"
                      />
                      <Button submit variant="primary">
                        Markera som skickad
                      </Button>
                    </BlockStack>
                  </fetcher.Form>
                )}
              </BlockStack>
            </Card>

            {/* Notes — somewhere for the print shop and the store to talk
                about a job without leaving the app. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Kommentarer
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="action" value="add_note" />
                  <BlockStack gap="200">
                    <TextField
                      label="Ny kommentar"
                      labelHidden
                      name="body"
                      multiline={3}
                      autoComplete="off"
                      placeholder="T.ex. omtryckt pga färgavvikelse"
                    />
                    <Button submit>Spara kommentar</Button>
                  </BlockStack>
                </fetcher.Form>

                {gangSheet.notes.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Inga kommentarer ännu.
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
                        <Text as="p" variant="bodySm">
                          {note.body}
                        </Text>
                        <Text as="p" variant="bodyXs" tone="subdued">
                          {new Date(note.createdAt).toLocaleString("sv-SE")}
                        </Text>
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    draft: { tone: undefined, label: "Utkast" },
    pending: { tone: "attention", label: "Väntar" },
    exported: { tone: "success", label: "Exporterad" },
    downloaded: { tone: "info", label: "Nedladdad" },
    printed: { tone: undefined, label: "Utskriven" },
    shipped: { tone: "success", label: "Skickad" },
  };
  const { tone, label } = map[status] || { tone: undefined, label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

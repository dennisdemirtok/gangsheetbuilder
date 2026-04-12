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
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getPresignedDownloadUrl } from "../lib/r2.server";
import { DPI_GOOD, DPI_WARNING } from "../lib/constants";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const gangSheet = await prisma.gangSheet.findUnique({
    where: { id: params.id },
    include: {
      images: true,
      exports: { orderBy: { createdAt: "desc" } },
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
  }

  return json({ success: true });
};

export default function OrderDetailPage() {
  const { gangSheet, exports: exportFiles, previewDownloadUrl } =
    useLoaderData<typeof loader>();
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
  };
  const { tone, label } = map[status] || { tone: undefined, label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

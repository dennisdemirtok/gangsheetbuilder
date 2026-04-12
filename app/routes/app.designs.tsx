import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  Pagination,
  Thumbnail,
  InlineGrid,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getPresignedDownloadUrl } from "../lib/r2.server";

const PAGE_SIZE = 24;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const shopDomain = session.shop;

  const [images, total] = await Promise.all([
    prisma.gangSheetImage.findMany({
      where: { gangSheet: { shopDomain } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        gangSheet: {
          select: { id: true, shopifyOrderId: true, status: true },
        },
      },
    }),
    prisma.gangSheetImage.count({
      where: { gangSheet: { shopDomain } },
    }),
  ]);

  // Generate presigned thumbnail URLs
  const imagesWithUrls = await Promise.all(
    images.map(async (img) => {
      let thumbnailPresigned = "";
      try {
        if (img.thumbnailUrl) {
          thumbnailPresigned = await getPresignedDownloadUrl(
            img.thumbnailUrl,
            3600,
          );
        }
      } catch {
        // ignore
      }
      return { ...img, thumbnailPresigned };
    }),
  );

  return json({
    images: imagesWithUrls,
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
};

export default function DesignsPage() {
  const { images, total, page, totalPages } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <Page>
      <TitleBar title="Designs" />
      <BlockStack gap="500">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            {total} designs totalt
          </Text>
        </InlineStack>

        <Layout>
          <Layout.Section>
            <Card>
              {images.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  Inga designs uppladdade.
                </Text>
              ) : (
                <BlockStack gap="300">
                  <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 6 }} gap="300">
                    {images.map((img: any) => (
                      <DesignCard key={img.id} image={img} />
                    ))}
                  </InlineGrid>

                  {totalPages > 1 && (
                    <InlineStack align="center">
                      <Pagination
                        hasPrevious={page > 1}
                        hasNext={page < totalPages}
                        onPrevious={() =>
                          setSearchParams({ page: String(page - 1) })
                        }
                        onNext={() =>
                          setSearchParams({ page: String(page + 1) })
                        }
                        label={`Sida ${page} av ${totalPages}`}
                      />
                    </InlineStack>
                  )}
                </BlockStack>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function DesignCard({ image }: { image: any }) {
  const dpiColor =
    (image.dpiX || 72) >= 200
      ? "success"
      : (image.dpiX || 72) >= 150
        ? "warning"
        : "critical";

  return (
    <Box
      padding="200"
      background="bg-surface-secondary"
      borderRadius="200"
    >
      <BlockStack gap="200">
        <div
          style={{
            width: "100%",
            aspectRatio: "1",
            background: "#f6f6f7",
            borderRadius: 6,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {image.thumbnailPresigned ? (
            <img
              src={image.thumbnailPresigned}
              alt={image.originalFilename}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">
              Ingen bild
            </Text>
          )}
        </div>

        <BlockStack gap="100">
          <Text
            as="p"
            variant="bodySm"
            fontWeight="semibold"
            truncate
          >
            {image.originalFilename}
          </Text>
          <InlineStack gap="200">
            <Badge tone={dpiColor}>{image.dpiX || 72} DPI</Badge>
            {image.bgRemoved && <Badge tone="info">BG borttagen</Badge>}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {image.widthPx}x{image.heightPx} px | {image.quantity} st
          </Text>
        </BlockStack>
      </BlockStack>
    </Box>
  );
}

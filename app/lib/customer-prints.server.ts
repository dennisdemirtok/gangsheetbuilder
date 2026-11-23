import prisma from "../db.server";
import { fileLink } from "./file-links.server";
import { getPresignedDownloadUrl } from "./r2.server";

/**
 * What a signed-in customer ordered: the prints of each of their orders.
 *
 * Shopify's account pages show a sheet only as "Gang sheet per meter", so a
 * customer could not see which prints were on an order while it was on its
 * way (Magnus, Multimontage, 2026-11-23). The customer comes from the app
 * proxy's signed logged_in_customer_id; their orders come from Shopify, and
 * only jobs of those orders are shown.
 */

type Admin = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

export interface CustomerPrintOrder {
  id: string;
  name: string;
  createdAt: string;
  fulfillment: string;
  jobs: CustomerPrintJob[];
}

export interface CustomerPrintJob {
  id: string;
  title: string;
  size: string | null;
  quantity: number;
  previewUrl: string | null;
  trackingUrl: string | null;
  /** The file itself, for jobs that are one file (cut jobs, uploaded sheets). */
  download: { url: string; name: string } | null;
  motifs: {
    name: string;
    size: string | null;
    quantity: number;
    thumbUrl: string | null;
    download: string;
  }[];
}

const LINK_DAYS = 2;
/** A whole sheet's print file is hundreds of MB; the motifs are what the customer wants back. */
const MAX_JOB_FILE_BYTES = 80 * 1024 * 1024;

function cm(mm: number | null | undefined): string {
  return (Math.round(mm || 0) / 10).toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

function sizeLabel(widthMm: number, heightMm: number): string | null {
  if (!widthMm || !heightMm) return null;
  return `${cm(widthMm)} × ${cm(heightMm)} cm`;
}

async function signed(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  return getPresignedDownloadUrl(key, 6 * 3600).catch(() => null);
}

function extOf(key: string): string {
  return (key.split("?")[0].split(".").pop() || "png").toLowerCase().slice(0, 5);
}

export async function customerPrintOrders(
  admin: Admin,
  shop: string,
  customerId: string,
  onlyOrder?: string | null,
): Promise<CustomerPrintOrder[]> {
  // Only Shopify's signed numeric id gets here; anything else would widen the search.
  if (!/^\d+$/.test(customerId)) return [];
  const response = await admin.graphql(
    `#graphql
    query CustomerOrders($q: String!) {
      orders(first: 60, sortKey: CREATED_AT, reverse: true, query: $q) {
        nodes { id name createdAt cancelledAt displayFulfillmentStatus }
      }
    }`,
    { variables: { q: `customer_id:${customerId}` } },
  );
  const body = (await response.json()) as {
    data?: { orders?: { nodes: { id: string; name: string; createdAt: string; cancelledAt: string | null; displayFulfillmentStatus: string}[] } };
  };
  // The app has no read_customers scope, so the order search by customer id
  // is what limits this to the customer's own orders.
  let orders = (body.data?.orders?.nodes || []).filter((o) => !o.cancelledAt);
  if (onlyOrder) {
    const wanted = onlyOrder.replace(/^#/, "");
    orders = orders.filter((o) => o.name.replace(/^#/, "") === wanted || o.id.endsWith(`/${wanted}`));
  }
  if (orders.length === 0) return [];

  const numericIds = orders.map((o) => o.id.split("/").pop()!);
  const jobs = await prisma.gangSheet.findMany({
    where: {
      shopDomain: shop,
      shopifyOrderId: { in: numericIds },
      status: { notIn: ["draft", "cancelled"] },
      // A sheet the shop combined cut jobs into is not something the customer ordered.
      NOT: { sessionId: { startsWith: "merged-" } },
    },
    orderBy: { createdAt: "asc" },
    include: { exports: true, images: { orderBy: { createdAt: "asc" } } },
  });

  const result: CustomerPrintOrder[] = [];
  for (const order of orders) {
    const numeric = order.id.split("/").pop()!;
    const own = jobs.filter((j) => j.shopifyOrderId === numeric);
    if (own.length === 0) continue;
    const printJobs: CustomerPrintJob[] = [];
    for (const job of own) {
      const orderNo = order.name.replace(/^#/, "");
      const motifs = await Promise.all(
        job.images
          .filter((img) => (img.quantity ?? 0) > 0)
          .map(async (img) => {
            const key = img.bgRemovedUrl || img.originalUrl;
            const base = (img.originalFilename || "motiv").replace(/\.[^.]+$/, "");
            return {
              name: img.originalFilename || "Motiv",
              size: img.displayWidth && img.displayHeight ? sizeLabel(img.displayWidth, img.displayHeight) : null,
              quantity: img.quantity ?? 1,
              thumbUrl: await signed(img.thumbnailUrl || img.originalUrl),
              download: fileLink(key, `${orderNo}_${base}.${extOf(key)}`, LINK_DAYS),
            };
          }),
      );

      let download: CustomerPrintJob["download"] = null;
      if (motifs.length === 0) {
        const exp = job.exports.find((e) => (e.fileSizeBytes ?? 0) <= MAX_JOB_FILE_BYTES);
        const key = exp?.url || job.exportUrl;
        if (key && !/^https?:\/\//.test(key)) {
          const name = `${orderNo}_${job.widthMm / 10}x${job.heightMm / 10}cm.${extOf(key)}`;
          download = { url: fileLink(key, name, LINK_DAYS), name };
        } else if (job.sourceFileUrl) {
          download = { url: job.sourceFileUrl, name: "Originalfil" };
        }
      }

      const isSheet = job.kind === "gang_sheet";
      printJobs.push({
        id: job.id,
        title: isSheet
          ? `Ark ${cm(job.widthMm)} × ${cm(job.heightMm)} cm`
          : `Tryck ${sizeLabel(job.widthMm, job.heightMm) || job.variantTitle || job.productTitle || ""}`.trim(),
        size: null,
        quantity: job.lineQuantity ?? 1,
        previewUrl: await signed(job.previewUrl),
        trackingUrl: job.trackingUrl,
        download,
        motifs,
      });
    }
    result.push({
      id: numeric,
      name: order.name,
      createdAt: order.createdAt,
      fulfillment: order.displayFulfillmentStatus,
      jobs: printJobs,
    });
  }
  return result;
}

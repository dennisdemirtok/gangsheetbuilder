import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useRevalidator, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  IndexFilters,
  Badge,
  Text,
  InlineStack,
  BlockStack,
  EmptySearchResult,
  useIndexResourceState,
  useSetIndexFiltersMode,
  Link as PolarisLink,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  OPEN_STATUSES,
  STATUS_FILTERS,
  formatDate,
  orderLabel,
  statusInfo,
  timeAgo,
} from "../lib/order-status";
import { KIND_LABEL, jobSize, type PrintKind } from "../lib/print-jobs";
import { withOrderDetails } from "../lib/order-details.server";
import { saveBlob } from "../lib/save-file";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  // The shop opens this to see what still needs doing, not the archive.
  const statusFilter = url.searchParams.get("status") || "open";
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);

  const base = { shopDomain: session.shop, shopifyOrderId: { not: null } };
  const where: any = { ...base };
  if (statusFilter === "open") {
    where.status = { in: OPEN_STATUSES };
  } else if (statusFilter !== "all") {
    where.status = statusFilter;
  }
  if (query) {
    const digits = query.replace(/^#/, "");
    where.OR = [
      { orderName: { contains: digits, mode: "insensitive" } },
      { customerName: { contains: query, mode: "insensitive" } },
      { shopifyOrderId: digits },
    ];
  }

  const [orders, totalCount, byStatus] = await Promise.all([
    prisma.gangSheet.findMany({
      where,
      orderBy: { createdAt: statusFilter === "open" ? "asc" : "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      include: { _count: { select: { images: true } } },
    }),
    prisma.gangSheet.count({ where }),
    prisma.gangSheet.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = { all: 0, open: 0 };
  for (const row of byStatus) {
    counts[row.status] = row._count._all;
    counts.all += row._count._all;
    if ((OPEN_STATUSES as string[]).includes(row.status)) counts.open += row._count._all;
  }

  const now = new Date();
  const named = await withOrderDetails(admin, session.shop, orders);

  return json({
    orders: named.map((o) => ({
      id: o.id,
      label: orderLabel(o),
      customerName: o.customerName,
      date: formatDate(o.createdAt),
      age: timeAgo(o.createdAt, now),
      printType: o.printType || "DTF Transfer",
      format: KIND_LABEL[(o.kind as PrintKind) || "gang_sheet"] ?? o.kind,
      cut: o.kind === "cut",
      size: jobSize(o),
      filmType: o.filmType,
      status: o.status,
    })),
    totalCount,
    counts,
    page,
    statusFilter,
    query,
  });
};

export default function OrdersPage() {
  const { orders, totalCount, counts, page, statusFilter, query } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const { mode, setMode } = useSetIndexFiltersMode();
  const [queryValue, setQueryValue] = useState(query);
  const [downloading, setDownloading] = useState(false);

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    setSearchParams(params);
  };

  // Search as the shop types, without a request per keystroke.
  useEffect(() => {
    if (queryValue.trim() === query) return;
    const t = setTimeout(() => setParam("q", queryValue.trim() || null), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryValue]);

  // Tabs instead of a status filter hidden behind a button: the queue
  // stages are what the shop switches between all day.
  const tabs = STATUS_FILTERS.map((f) => ({
    id: f.value,
    content: f.label,
    badge: counts[f.value] ? String(counts[f.value]) : undefined,
    onAction: () => {},
  }));
  const selectedTab = Math.max(
    0,
    STATUS_FILTERS.findIndex((f) => f.value === statusFilter),
  );

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(orders);

  /*
   * Bulk download used to be a link to the ZIP route. Inside the embedded
   * admin that navigation carried no session token, so nothing came back.
   * App Bridge's fetch adds the token; the ZIP is saved from memory.
   */
  const downloadSelected = async () => {
    setDownloading(true);
    shopify.toast.show("Preparing print files…");
    try {
      const res = await fetch(`/app/orders/download?ids=${selectedResources.join(",")}`);
      if (!res.ok) throw new Error(await res.text());
      saveBlob(await res.blob(), `print-files-${new Date().toISOString().slice(0, 10)}.zip`);
      clearSelection();
      revalidator.revalidate();
    } catch (err) {
      console.error(err);
      shopify.toast.show("Could not download the print files", { isError: true });
    } finally {
      setDownloading(false);
    }
  };

  const rowMarkup = orders.map((order, index) => (
    <IndexTable.Row
      id={order.id}
      key={order.id}
      position={index}
      selected={selectedResources.includes(order.id)}
    >
      <IndexTable.Cell>
        {/* Polaris' primary link: the whole row opens the order, and the
            checkbox still works for bulk download. */}
        <PolarisLink dataPrimaryLink url={`/app/orders/${order.id}`} removeUnderline monochrome>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {order.label}
          </Text>
        </PolarisLink>
      </IndexTable.Cell>
      <IndexTable.Cell>{order.customerName || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="0">
          <Text as="span" variant="bodyMd">
            {order.date}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {order.age}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {/* What to make: the type, and whether it goes out on the roll or
            cut per design — the two are produced differently. */}
        <BlockStack gap="0">
          <Text as="span" variant="bodyMd">
            {order.printType}
          </Text>
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Text as="span" variant="bodySm" tone={order.cut ? undefined : "subdued"} fontWeight={order.cut ? "semibold" : undefined}>
              {order.format}
            </Text>
            {order.filmType !== "standard" && <Badge size="small">{order.filmType}</Badge>}
          </InlineStack>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd">
          {order.size}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={order.status} />
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <Page>
      <TitleBar title="Orders" />
      <Card padding="0">
        <IndexFilters
          tabs={tabs}
          selected={selectedTab}
          onSelect={(i) => setParam("status", STATUS_FILTERS[i].value)}
          queryValue={queryValue}
          queryPlaceholder="Search order number or customer"
          onQueryChange={setQueryValue}
          onQueryClear={() => setQueryValue("")}
          filters={[]}
          appliedFilters={[]}
          onClearAll={() => setQueryValue("")}
          hideFilters
          canCreateNewView={false}
          mode={mode}
          setMode={setMode}
          cancelAction={{ onAction: () => setQueryValue(""), disabled: false, loading: false }}
        />
        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={orders.length}
          selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
          onSelectionChange={handleSelectionChange}
          promotedBulkActions={[
            {
              content: downloading ? "Preparing…" : "Download print files",
              onAction: downloadSelected,
              disabled: downloading,
            },
          ]}
          headings={[
            { title: "Order" },
            { title: "Customer" },
            { title: "Ordered" },
            { title: "Print" },
            { title: "Size" },
            { title: "Status" },
          ]}
          emptyState={
            <EmptySearchResult
              title={
                query
                  ? "No matching orders"
                  : statusFilter === "open"
                    ? "All caught up"
                    : "No orders here"
              }
              description={
                query
                  ? "Try another order number or name."
                  : statusFilter === "open"
                    ? "New orders appear here as soon as they are paid."
                    : undefined
              }
              withIllustration
            />
          }
          pagination={
            totalPages > 1
              ? {
                  hasPrevious: page > 1,
                  hasNext: page < totalPages,
                  onPrevious: () => setParam("page", String(page - 1)),
                  onNext: () => setParam("page", String(page + 1)),
                  label: `Page ${page} of ${totalPages}`,
                }
              : undefined
          }
        >
          {rowMarkup}
        </IndexTable>
      </Card>
    </Page>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { tone, label } = statusInfo(status);
  return <Badge tone={tone}>{label}</Badge>;
}

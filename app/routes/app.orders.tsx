import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  Text,
  Filters,
  ChoiceList,
  useIndexResourceState,
  Button,
  InlineStack,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") || "all";
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = 20;

  const where: any = {
    shopDomain: session.shop,
    shopifyOrderId: { not: null },
  };
  if (statusFilter !== "all") {
    where.status = statusFilter;
  }

  const [orders, totalCount] = await Promise.all([
    prisma.gangSheet.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
      include: {
        _count: { select: { images: true } },
        exports: { take: 1 },
      },
    }),
    prisma.gangSheet.count({ where }),
  ]);

  return json({
    orders,
    totalCount,
    page,
    pageSize,
    statusFilter,
  });
};

export default function OrdersPage() {
  const { orders, totalCount, page, pageSize, statusFilter } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const resourceName = {
    singular: "order",
    plural: "ordrar",
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders.map((o) => ({ id: o.id })));

  const statusOptions = [
    { label: "Alla", value: "all" },
    { label: "Väntar", value: "pending" },
    { label: "Exporterad", value: "exported" },
    { label: "Nedladdad", value: "downloaded" },
    { label: "Utskriven", value: "printed" },
  ];

  const filters = [
    {
      key: "status",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={statusOptions}
          selected={[statusFilter]}
          onChange={(val) => {
            const params = new URLSearchParams(searchParams);
            params.set("status", val[0]);
            params.set("page", "1");
            setSearchParams(params);
          }}
        />
      ),
      shortcut: true,
    },
  ];

  const rowMarkup = orders.map((order, index) => (
    <IndexTable.Row
      id={order.id}
      key={order.id}
      position={index}
      selected={selectedResources.includes(order.id)}
      onClick={() => navigate(`/app/orders/${order.id}`)}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="bold">
          #{order.shopifyOrderId}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(order.createdAt).toLocaleDateString("sv-SE")}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {order.widthMm / 10} × {order.heightMm / 10} cm
      </IndexTable.Cell>
      <IndexTable.Cell>{order.filmType}</IndexTable.Cell>
      <IndexTable.Cell>{order._count.images}</IndexTable.Cell>
      <IndexTable.Cell>
        {order.priceSEK ? `${order.priceSEK} kr` : "-"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={order.status} />
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <Page>
      <TitleBar title="Gang Sheet-ordrar" />
      <BlockStack gap="400">
        {selectedResources.length > 0 && (
          <InlineStack gap="200">
            <Button
              url={`/app/orders/download?ids=${selectedResources.join(",")}`}
            >
              Ladda ner valda ({selectedResources.length})
            </Button>
          </InlineStack>
        )}
        <Card padding="0">
          <IndexTable
            resourceName={resourceName}
            itemCount={orders.length}
            selectedItemsCount={
              allResourcesSelected ? "All" : selectedResources.length
            }
            onSelectionChange={handleSelectionChange}
            headings={[
              { title: "Order" },
              { title: "Datum" },
              { title: "Storlek" },
              { title: "Film" },
              { title: "Designs" },
              { title: "Pris" },
              { title: "Status" },
            ]}
            filters={filters}
            appliedFilters={
              statusFilter !== "all"
                ? [
                    {
                      key: "status",
                      label: statusOptions.find((o) => o.value === statusFilter)
                        ?.label || statusFilter,
                      onRemove: () => {
                        const params = new URLSearchParams(searchParams);
                        params.delete("status");
                        setSearchParams(params);
                      },
                    },
                  ]
                : []
            }
          >
            {rowMarkup}
          </IndexTable>
        </Card>

        {totalPages > 1 && (
          <InlineStack align="center" gap="200">
            <Button
              disabled={page <= 1}
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                params.set("page", String(page - 1));
                setSearchParams(params);
              }}
            >
              Föregående
            </Button>
            <Text as="span" variant="bodySm">
              Sida {page} av {totalPages}
            </Text>
            <Button
              disabled={page >= totalPages}
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                params.set("page", String(page + 1));
                setSearchParams(params);
              }}
            >
              Nästa
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    pending: { tone: "attention", label: "Väntar" },
    exported: { tone: "success", label: "Exporterad" },
    downloaded: { tone: "info", label: "Nedladdad" },
    printed: { tone: undefined, label: "Utskriven" },
  };
  const { tone, label } = map[status] || { tone: undefined, label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptySearchResult,
  FormLayout,
  IndexTable,
  InlineStack,
  Link as PolarisLink,
  Page,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatDateTime } from "../lib/order-status";
import { TEAM_STATUS, type TeamDigit, type TeamLogo, type TeamShirt } from "../lib/team-orders";

/**
 * Team orders from /pages/lag: Clique shirts the shop orders from New Wave
 * (delivered straight to the customer), digits picked from the shop's own
 * stock, and logos printed in Poland and sent to the shop. The shop ships
 * digits and logos to the customer itself.
 */

const FILTERS = [
  { value: "open", label: "Open", statuses: ["new", "ordered"] },
  { value: "new", label: "To do", statuses: ["new"] },
  { value: "ordered", label: "In progress", statuses: ["ordered"] },
  { value: "shipped", label: "Done", statuses: ["shipped"] },
  { value: "all", label: "All", statuses: null },
] as const;

const SHIP_TO_FIELDS = ["name", "company", "address1", "address2", "zip", "city", "countryCode", "phone", "email"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = FILTERS.find((f) => f.value === url.searchParams.get("status")) ?? FILTERS[0];

  const [orders, grouped, config] = await Promise.all([
    prisma.teamOrder.findMany({
      where: {
        shopDomain: session.shop,
        ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
      },
      orderBy: { createdAt: filter.value === "shipped" || filter.value === "all" ? "desc" : "asc" },
      take: 200,
    }),
    prisma.teamOrder.groupBy({ by: ["status"], where: { shopDomain: session.shop }, _count: true }),
    prisma.appConfig.findUnique({ where: { shopDomain: session.shop }, select: { teamShipTo: true } }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));

  return json({
    filter: filter.value,
    counts: Object.fromEntries(
      FILTERS.map((f) => [
        f.value,
        f.statuses ? f.statuses.reduce((n, s) => n + (counts[s] ?? 0), 0) : grouped.reduce((n, g) => n + g._count, 0),
      ]),
    ),
    shipTo: (config?.teamShipTo as Record<string, string> | null) ?? null,
    orders: orders.map((o) => {
      const shirts = o.shirts as unknown as TeamShirt[];
      const digits = o.digits as unknown as TeamDigit[];
      const logos = o.logos as unknown as TeamLogo[];
      return {
        id: o.id,
        label: o.orderName || `#${o.shopifyOrderId}`,
        customerName: o.customerName,
        team: o.team,
        ordered: formatDateTime(o.createdAt),
        shirts: shirts.reduce((n, s) => n + s.quantity, 0),
        digits: digits.reduce((n, d) => n + d.quantity, 0),
        logos: logos.reduce((n, l) => n + l.quantity, 0),
        status: o.status,
      };
    }),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("action") !== "save_ship_to") return json({ errors: ["Unknown action."] }, { status: 400 });

  const shipTo = Object.fromEntries(SHIP_TO_FIELDS.map((k) => [k, String(form.get(k) || "").trim()]));
  shipTo.countryCode = (shipTo.countryCode || "SE").toUpperCase();
  const missing = (["name", "address1", "zip", "city", "phone"] as const).filter((k) => !shipTo[k]);
  if (missing.length) return json({ errors: [`Fill in ${missing.join(", ")}.`] }, { status: 400 });

  await prisma.appConfig.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop, teamShipTo: shipTo },
    update: { teamShipTo: shipTo },
  });
  return json({ success: true });
};

export default function TeamOrdersPage() {
  const { filter, counts, orders, shipTo } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = Math.max(0, FILTERS.findIndex((f) => f.value === filter));

  const rows = orders.map((order, index) => {
    const status = TEAM_STATUS[order.status] ?? { label: order.status, tone: undefined };
    const parts = [
      order.shirts ? `${order.shirts} shirts` : "",
      order.digits ? `${order.digits} digits` : "",
      order.logos ? `${order.logos} logos` : "",
    ].filter(Boolean);
    return (
      <IndexTable.Row id={order.id} key={order.id} position={index}>
        <IndexTable.Cell>
          <PolarisLink dataPrimaryLink url={`/app/team/${order.id}`} removeUnderline monochrome>
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {order.label}
            </Text>
          </PolarisLink>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="0">
            <span>{order.customerName || "-"}</span>
            {order.team && (
              <Text as="span" variant="bodySm" tone="subdued">
                {order.team}
              </Text>
            )}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>{order.ordered}</IndexTable.Cell>
        <IndexTable.Cell>{parts.join(" · ") || "-"}</IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={status.tone}>{status.label}</Badge>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="Team orders" />
      <BlockStack gap="300">
        <Text as="p" tone="subdued">
          Orders from the team page. Order the shirts from New Wave (delivered to the customer), pick the digits from
          stock, and send them with the logos when the print shop has delivered.
        </Text>
        {!shipTo && (
          <Banner tone="warning" title="Set where the logos go">
            Until an address is saved below, a team order&apos;s logos are booked to the customer like any print order.
          </Banner>
        )}
        <Card padding="0">
          <Tabs
            tabs={FILTERS.map((f) => ({
              id: f.value,
              content: `${f.label}${counts[f.value] ? ` (${counts[f.value]})` : ""}`,
            }))}
            selected={selected}
            onSelect={(i) => {
              const params = new URLSearchParams(searchParams);
              params.set("status", FILTERS[i].value);
              setSearchParams(params);
            }}
          />
          <IndexTable
            resourceName={{ singular: "order", plural: "orders" }}
            itemCount={orders.length}
            selectable={false}
            headings={[{ title: "Order" }, { title: "Customer" }, { title: "Ordered" }, { title: "Contents" }, { title: "Status" }]}
            emptyState={
              <EmptySearchResult
                title="No team orders here"
                description="Orders with Clique shirts or stock digits show up here when they are paid."
              />
            }
          >
            {rows}
          </IndexTable>
        </Card>
        <ShipToCard shipTo={shipTo} />
      </BlockStack>
    </Page>
  );
}

function ShipToCard({ shipTo }: { shipTo: Record<string, string> | null }) {
  const fetcher = useFetcher<{ success?: boolean; errors?: string[] }>();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(SHIP_TO_FIELDS.map((k) => [k, shipTo?.[k] ?? (k === "countryCode" ? "SE" : "")])),
  );
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) setSaved(true);
  }, [fetcher.state, fetcher.data]);
  const set = (k: string) => (v: string) => {
    setSaved(false);
    setValues((x) => ({ ...x, [k]: v }));
  };

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Logos go to
          </Text>
          <Text as="p" tone="subdued">
            The print shop sends a team order&apos;s logos here, and the customer gets no tracking email for that
            parcel. Applies to orders that come in after saving.
          </Text>
        </BlockStack>
        {fetcher.data?.errors && <Banner tone="critical">{fetcher.data.errors.join(" ")}</Banner>}
        <FormLayout>
          <FormLayout.Group>
            <TextField label="Name" value={values.name} onChange={set("name")} autoComplete="name" />
            <TextField label="Company" value={values.company} onChange={set("company")} autoComplete="organization" />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField label="Address" value={values.address1} onChange={set("address1")} autoComplete="address-line1" />
            <TextField label="Address 2" value={values.address2} onChange={set("address2")} autoComplete="address-line2" />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField label="Postcode" value={values.zip} onChange={set("zip")} autoComplete="postal-code" />
            <TextField label="City" value={values.city} onChange={set("city")} autoComplete="address-level2" />
            <TextField label="Country code" value={values.countryCode} onChange={set("countryCode")} autoComplete="country" />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField label="Phone" value={values.phone} onChange={set("phone")} autoComplete="tel" />
            <TextField label="Email" value={values.email} onChange={set("email")} autoComplete="email" />
          </FormLayout.Group>
        </FormLayout>
        <InlineStack gap="300" blockAlign="center">
          <Button
            variant="primary"
            loading={fetcher.state !== "idle"}
            onClick={() => fetcher.submit({ action: "save_ship_to", ...values }, { method: "post" })}
          >
            Save address
          </Button>
          {saved && <Text as="span" tone="success">Saved</Text>}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

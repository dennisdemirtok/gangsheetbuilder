import { useEffect, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  FormLayout,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

/**
 * One more BWS pickup for an order that has shipped once — a reprint after a
 * complaint, a wrong item. Only the booking: no email to the customer or the
 * print shop, nothing in Shopify. The shop downloads the label and sends it
 * to Poland itself.
 */

export interface ExtraShipmentRow {
  id: string;
  reference: string;
  reason: string | null;
  bwsBookingId: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  hasLabel: boolean;
  pickupDate: string;
  service: string | null;
  price: string | null;
  bookedAt: string;
}

type ActionData = { success?: boolean; errors?: string[]; notice?: string };

/** Rows of the address form; two fields share a row. */
const ADDRESS_ROWS = [
  [["name", "Name"]],
  [["company", "Company"]],
  [["address1", "Street"]],
  [["address2", "Street 2"]],
  [["zip", "Postcode"], ["city", "City"]],
  [["countryCode", "Country (SE, NO…)"], ["phone", "Phone"]],
] as const;

type AddressKey = (typeof ADDRESS_ROWS)[number][number][0] | "email";

export function ExtraShipmentCard({
  shipments,
  address,
  customerName,
  defaults,
  services,
  pickupFrom,
  isTest,
  missingConfig,
  onDownloadLabel,
  downloading,
}: {
  shipments: ExtraShipmentRow[];
  /** The order's stored shipping address: where the first parcel went. */
  address: Record<string, string | null> | null;
  customerName: string | null;
  defaults: { pickupDate: string; weightKg: number; service: string };
  services: { code: string; label: string }[];
  pickupFrom: string;
  isTest: boolean;
  missingConfig: string[];
  onDownloadLabel: (id: string) => void;
  downloading: string | null;
}) {
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const [open, setOpen] = useState(false);
  const [editAddress, setEditAddress] = useState(false);
  const [reason, setReason] = useState("");
  const [pickupDate, setPickupDate] = useState(defaults.pickupDate);
  const [weightKg, setWeightKg] = useState(String(defaults.weightKg));
  const [service, setService] = useState(defaults.service);
  const initialAddress = (): Record<AddressKey, string> => ({
    name: address?.name || customerName || "",
    company: address?.company || "",
    address1: address?.address1 || "",
    address2: address?.address2 || "",
    zip: address?.zip || "",
    city: address?.city || "",
    countryCode: address?.countryCode || "SE",
    phone: address?.phone || "",
    email: address?.email || "",
  });
  const [to, setTo] = useState(initialAddress);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setOpen(false);
      setEditAddress(false);
      setReason("");
    }
  }, [fetcher.state, fetcher.data]);

  const book = () =>
    fetcher.submit(
      { action: "book_extra", reason, pickupDate, weightKg, service, ...to },
      { method: "post" },
    );

  const serviceName = (code: string | null) =>
    services.find((s) => s.code === code)?.label || code || "BWS default";
  const addressIncomplete = !to.name.trim() || !to.address1.trim() || !to.zip.trim() || !to.city.trim();

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Extra shipment
          </Text>
          {isTest && <Badge tone="attention">BWS test</Badge>}
        </InlineStack>

        {shipments.map((x) => (
          <BlockStack gap="150" key={x.id}>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {x.reference}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Booked {x.bookedAt}
              </Text>
            </InlineStack>
            {x.reason && (
              <Text as="p" variant="bodySm" tone="subdued">
                {x.reason}
              </Text>
            )}
            <Row label="Pickup" value={`${x.pickupDate}, ${pickupFrom}`} />
            <Row label="Service" value={serviceName(x.service)} />
            {x.price && <Row label="BWS charge" value={x.price} />}
            {x.bwsBookingId && <Row label="Booking" value={x.bwsBookingId} />}
            {x.trackingNumber && <Row label="Tracking" value={x.trackingNumber} />}
            <InlineStack gap="200">
              {x.hasLabel && (
                <Button onClick={() => onDownloadLabel(x.id)} loading={downloading === x.id}>
                  Download label
                </Button>
              )}
              {x.trackingUrl && (
                <Button url={x.trackingUrl} external>
                  Track parcel
                </Button>
              )}
            </InlineStack>
            <Divider />
          </BlockStack>
        ))}

        {fetcher.data?.notice && !busy && <Banner tone="success">{fetcher.data.notice}</Banner>}
        {fetcher.data?.errors && !busy && (
          <Banner tone={fetcher.data.success ? "warning" : "critical"} title={fetcher.data.success ? undefined : "Not booked"}>
            <BlockStack gap="100">
              {fetcher.data.errors.map((e) => (
                <Text as="p" variant="bodySm" key={e}>
                  {e}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {!open ? (
          <BlockStack gap="200">
            {shipments.length === 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                Send something more on this order, e.g. a reprint after a complaint.
              </Text>
            )}
            <InlineStack>
              <Button onClick={() => setOpen(true)}>Book another pickup</Button>
            </InlineStack>
          </BlockStack>
        ) : (
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              A new BWS courier at the print shop, with its own label and tracking. Nobody is
              emailed and Shopify is not changed: download the label and send it to the print
              shop yourself. The order's first booking stays as it is.
            </Text>
            <TextField
              label="Reason (only for you)"
              value={reason}
              onChange={setReason}
              placeholder="e.g. Complaint: wrong colour, reprint"
              autoComplete="off"
            />

            {editAddress ? (
              <BlockStack gap="200">
                <FormLayout>
                  {ADDRESS_ROWS.map((row) => (
                    <FormLayout.Group condensed key={row[0][0]}>
                      {row.map(([key, label]) => (
                        <TextField
                          key={key}
                          label={label}
                          value={to[key]}
                          onChange={(v) => setTo((a) => ({ ...a, [key]: v }))}
                          autoComplete="off"
                        />
                      ))}
                    </FormLayout.Group>
                  ))}
                </FormLayout>
                <InlineStack>
                  <Button
                    variant="plain"
                    onClick={() => {
                      setTo(initialAddress());
                      setEditAddress(false);
                    }}
                  >
                    Use the order's address
                  </Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <BlockStack gap="050">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodySm" tone="subdued">
                    To
                  </Text>
                  <Button variant="plain" onClick={() => setEditAddress(true)}>
                    Change address
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm">
                  {[to.company, to.name].filter(Boolean).join(", ")}
                </Text>
                <Text as="p" variant="bodySm">
                  {[to.address1, to.address2].filter(Boolean).join(", ")}
                </Text>
                <Text as="p" variant="bodySm">
                  {[to.zip, to.city, to.countryCode].filter(Boolean).join(" ")}
                </Text>
                {to.phone && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {to.phone}
                  </Text>
                )}
              </BlockStack>
            )}

            <Select
              label="Service"
              value={service}
              onChange={setService}
              options={services.map((s) => ({ label: s.label, value: s.code }))}
            />
            <InlineStack gap="200" wrap={false}>
              <TextField
                label="Pickup date"
                type="date"
                value={pickupDate}
                onChange={setPickupDate}
                min={defaults.pickupDate}
                helpText={`Courier at ${pickupFrom}`}
                autoComplete="off"
              />
              <TextField
                label="Weight (kg)"
                type="number"
                value={weightKg}
                onChange={setWeightKg}
                min={0.1}
                step={0.1}
                autoComplete="off"
              />
            </InlineStack>
            {missingConfig.length > 0 && (
              <Banner tone="warning">Missing server settings: {missingConfig.join(", ")}</Banner>
            )}
            <InlineStack gap="200">
              <Button
                variant="primary"
                onClick={book}
                loading={busy}
                disabled={busy || addressIncomplete || missingConfig.length > 0}
              >
                Book pickup
              </Button>
              <Button variant="plain" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
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

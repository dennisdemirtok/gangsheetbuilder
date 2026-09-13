import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

/**
 * BWS courier booking for an order.
 *
 * One click books the pickup at the print shop in Poland (DDP, one
 * 60×5×5 cm tube) and BWS returns the label and tracking in the same
 * response. The booking covers the whole Shopify order, so every sheet of
 * the order shows the same label.
 */

export interface BwsShippingData {
  summary: {
    meters: number;
    weightKg: number;
    valueSEK: number;
    pickupDate: string;
    sheetCount: number;
    otherLineItems: { title: string; quantity: number }[];
  };
  pickup: { name: string; city: string };
  pickupFrom: string;
  packageCm: { length: number; width: number; height: number };
  missingConfig: string[];
  isTest: boolean;
  /** BWS_SIMULATE is on: a rejected test booking is faked instead. */
  simulation: boolean;
  /** This order's booking was faked. */
  simulated: boolean;
}

interface SheetShippingFields {
  status: string;
  shippingStatus: string | null;
  shippingError: string | null;
  bwsBookingId: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  pickupDate: string | null;
  shopifyFulfillmentId: string | null;
  fulfillmentError: string | null;
}

export function BwsShippingCard({
  sheet,
  shipping,
  hasLabel,
  onDownloadLabel,
  downloadingLabel,
}: {
  sheet: SheetShippingFields;
  shipping: BwsShippingData;
  hasLabel: boolean;
  /** Saves the label in place; a new-tab link from the admin iframe opened blank. */
  onDownloadLabel: () => void;
  downloadingLabel?: boolean;
}) {
  const fetcher = useFetcher<{ success?: boolean; errors?: string[] }>();
  const [pickupDate, setPickupDate] = useState(shipping.summary.pickupDate);
  const [weightKg, setWeightKg] = useState(String(shipping.summary.weightKg));

  const booking = fetcher.state !== "idle" || sheet.shippingStatus === "booking";
  const errors =
    fetcher.data?.errors ??
    (sheet.shippingStatus === "failed" && sheet.shippingError
      ? sheet.shippingError.split(" · ")
      : null);
  const { packageCm: pkg } = shipping;
  const others = shipping.summary.otherLineItems;
  const othersBanner = others.length > 0 && (
    <Banner tone="warning" title="Only the DTF transfers ship from Poland">
      <Text as="p" variant="bodySm">
        This order also contains{" "}
        {others.map((o) => `${o.quantity} × ${o.title}`).join(", ")}. Those are
        not in this BWS shipment and stay unfulfilled in Shopify until they are
        sent separately.
      </Text>
    </Banner>
  );

  if (sheet.shippingStatus === "booked") {
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              BWS shipment
            </Text>
            {shipping.simulated ? (
              <Badge tone="attention">Simulated</Badge>
            ) : (
              <Badge tone="success">Booked</Badge>
            )}
          </InlineStack>
          {shipping.simulated && (
            <Banner tone="warning">
              Test booking — BWS has not activated our customer yet, so this
              label and tracking number are placeholders.
            </Banner>
          )}
          {sheet.pickupDate && (
            <Row label="Pickup" value={`${sheet.pickupDate}, ${shipping.pickupFrom}`} />
          )}
          {sheet.bwsBookingId && <Row label="Booking" value={sheet.bwsBookingId} />}
          {sheet.trackingNumber && <Row label="Tracking" value={sheet.trackingNumber} />}
          {hasLabel ? (
            <Button onClick={onDownloadLabel} loading={downloadingLabel} variant="primary" fullWidth>
              Download shipping label
            </Button>
          ) : (
            <Banner tone="warning">BWS did not return a label.</Banner>
          )}
          {sheet.trackingUrl && (
            <Button url={sheet.trackingUrl} external fullWidth>
              Track parcel
            </Button>
          )}
          {sheet.shopifyFulfillmentId ? (
            <Text as="p" variant="bodySm" tone="subdued">
              Customer notified with tracking (DTF items fulfilled in Shopify).
            </Text>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="action" value="send_tracking" />
              <BlockStack gap="200">
                <Banner tone="critical" title="Customer has not received tracking">
                  <Text as="p" variant="bodySm">
                    {fetcher.data?.errors?.join(" · ") ||
                      sheet.fulfillmentError ||
                      "The Shopify fulfilment was not created."}
                  </Text>
                </Banner>
                <Button submit loading={fetcher.state !== "idle"} fullWidth>
                  Send tracking to customer
                </Button>
              </BlockStack>
            </fetcher.Form>
          )}
          {othersBanner}
        </BlockStack>
      </Card>
    );
  }

  if (sheet.status === "shipped") return null;

  return (
    <Card>
      <fetcher.Form method="post">
        <input type="hidden" name="action" value="book_bws" />
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              BWS shipment
            </Text>
            {shipping.isTest && (
              <Badge tone="attention">
                {shipping.simulation ? "Test · simulated" : "Test environment"}
              </Badge>
            )}
          </InlineStack>
          {othersBanner}
          <Text as="p" variant="bodySm" tone="subdued">
            Courier pickup at {shipping.pickup.name}
            {shipping.pickup.city ? `, ${shipping.pickup.city}` : ""} from{" "}
            {shipping.pickupFrom} · DDP · {pkg.length}×{pkg.width}×{pkg.height} cm
            · {shipping.summary.meters} m film
            {shipping.summary.sheetCount > 1
              ? ` (${shipping.summary.sheetCount} sheets in this order)`
              : ""}
          </Text>
          <InlineStack gap="200" wrap={false}>
            <TextField
              label="Pickup date"
              type="date"
              name="pickupDate"
              value={pickupDate}
              onChange={setPickupDate}
              autoComplete="off"
            />
            <TextField
              label="Weight (kg)"
              type="number"
              name="weightKg"
              value={weightKg}
              onChange={setWeightKg}
              min={0.1}
              step={0.5}
              autoComplete="off"
            />
          </InlineStack>
          {shipping.missingConfig.length > 0 && (
            <Banner tone="warning">
              Missing server settings: {shipping.missingConfig.join(", ")}
            </Banner>
          )}
          {errors && !booking && (
            <Banner tone="critical" title="BWS could not book this shipment">
              <BlockStack gap="100">
                {errors.map((e) => (
                  <Text as="p" variant="bodySm" key={e}>
                    {e}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          )}
          <Button
            submit
            // Primary only once the sheet is printed: before that, printing
            // is the next step and two dark buttons competed for it.
            variant={sheet.status === "printed" ? "primary" : undefined}
            loading={booking}
            disabled={booking || shipping.missingConfig.length > 0}
            fullWidth
          >
            Book BWS pickup & create label
          </Button>
        </BlockStack>
      </fetcher.Form>
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

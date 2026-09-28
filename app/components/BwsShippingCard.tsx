import { useEffect, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { formatDateTime } from "../lib/order-status";

/**
 * Shipping and hand-over to the print shop, for a whole Shopify order.
 *
 * The usual move is one button: book the BWS courier (service, date, weight
 * chosen here) and email the print shop the files, the label and the order
 * details. The customer is told production has started, and Shopify sends
 * them the tracking at pickup time.
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
  /** The services the shop can book, from the server. */
  services: { code: string; label: string; hint: string }[];
  isTest: boolean;
  /** BWS_SIMULATE is on: a rejected test booking is faked instead. */
  simulation: boolean;
  /** This order's booking was faked. */
  simulated: boolean;
  printShop: {
    defaultTo: string;
    missingMail: string[];
    customerEmail: string | null;
  };
}

interface SheetShippingFields {
  status: string;
  shippingStatus: string | null;
  shippingError: string | null;
  bwsBookingId: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  pickupDate: string | null;
  shippingService: string | null;
  shippingPrice: number | null;
  shippingCurrency: string | null;
  shopifyFulfillmentId: string | null;
  fulfillmentError: string | null;
  sentToPrintShopAt: string | null;
  sentToPrintShopTo: string | null;
  productionMailSentAt: string | null;
}

type ActionData = { success?: boolean; errors?: string[]; notice?: string };

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
  const fetcher = useFetcher<ActionData>();
  const trackingFetcher = useFetcher<ActionData>();
  const booked = sheet.shippingStatus === "booked";

  const [pickupDate, setPickupDate] = useState(shipping.summary.pickupDate);
  const [weightKg, setWeightKg] = useState(String(shipping.summary.weightKg));
  // Blue Express is what most customers get; Economy when speed does not matter.
  const [service, setService] = useState(sheet.shippingService || "EXP");
  const [bookToo, setBookToo] = useState(!booked);
  const [to, setTo] = useState(sheet.sentToPrintShopTo || shipping.printShop.defaultTo);
  const [message, setMessage] = useState("");
  const [notify, setNotify] = useState(!sheet.productionMailSentAt);
  const [showResend, setShowResend] = useState(false);

  const busy = fetcher.state !== "idle" || sheet.shippingStatus === "booking";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setMessage("");
      setShowResend(false);
    }
  }, [fetcher.state, fetcher.data]);

  const errors =
    fetcher.data?.errors ??
    (sheet.shippingStatus === "failed" && sheet.shippingError
      ? sheet.shippingError.split(" · ")
      : null);
  const mailMissing = shipping.printShop.missingMail;
  const bwsMissing = shipping.missingConfig;
  const willBook = !booked && bookToo;

  const submit = (action: "send_print_shop" | "book_bws") =>
    fetcher.submit(
      {
        action,
        book: willBook ? "1" : "0",
        service,
        pickupDate,
        weightKg,
        to,
        message,
        notifyCustomer: notify ? "1" : "0",
      },
      { method: "post" },
    );

  const { packageCm: pkg } = shipping;
  const others = shipping.summary.otherLineItems;
  const serviceName =
    shipping.services.find((s) => s.code === sheet.shippingService)?.label ||
    sheet.shippingService ||
    "BWS default";

  if (sheet.status === "shipped" && !booked && !sheet.sentToPrintShopAt) return null;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Shipping & print shop
          </Text>
          {booked ? (
            <Badge tone={shipping.simulated ? "attention" : "success"}>
              {shipping.simulated ? "Simulated" : "Booked"}
            </Badge>
          ) : shipping.isTest ? (
            <Badge tone="attention">BWS test</Badge>
          ) : null}
        </InlineStack>

        {others.length > 0 && (
          <Banner tone="warning" title="Only the printed items ship from Poland">
            <Text as="p" variant="bodySm">
              Also on this order: {others.map((o) => `${o.quantity} × ${o.title}`).join(", ")}.
              Not in the BWS parcel — they stay unfulfilled in Shopify until sent separately.
            </Text>
          </Banner>
        )}

        {/* ── Booking ── */}
        {booked ? (
          <BlockStack gap="150">
            {sheet.pickupDate && (
              <Row label="Pickup" value={`${sheet.pickupDate}, ${shipping.pickupFrom}`} />
            )}
            <Row label="Service" value={serviceName} />
            {sheet.shippingPrice != null && (
              <Row
                label="BWS charge"
                value={`${sheet.shippingPrice.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${sheet.shippingCurrency || ""}`.trim()}
              />
            )}
            {sheet.bwsBookingId && <Row label="Booking" value={sheet.bwsBookingId} />}
            {sheet.trackingNumber && <Row label="Tracking" value={sheet.trackingNumber} />}
            <InlineStack gap="200">
              {hasLabel && (
                <Button onClick={onDownloadLabel} loading={downloadingLabel}>
                  Download label
                </Button>
              )}
              {sheet.trackingUrl && (
                <Button url={sheet.trackingUrl} external>
                  Track parcel
                </Button>
              )}
            </InlineStack>
          </BlockStack>
        ) : (
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              Courier pickup at {shipping.pickup.name}
              {shipping.pickup.city ? `, ${shipping.pickup.city}` : ""} · DDP ·{" "}
              {pkg.length}×{pkg.width}×{pkg.height} cm · {shipping.summary.meters} m film
              {shipping.summary.sheetCount > 1 ? ` · ${shipping.summary.sheetCount} print jobs` : ""}
            </Text>
            <Select
              label="Service"
              value={service}
              onChange={setService}
              options={shipping.services.map((s) => ({ label: s.label, value: s.code }))}
            />
            <InlineStack gap="200" wrap={false}>
              <TextField
                label="Pickup date"
                type="date"
                value={pickupDate}
                onChange={setPickupDate}
                min={shipping.summary.pickupDate}
                helpText={`Courier at ${shipping.pickupFrom}`}
                autoComplete="off"
              />
              <TextField
                label="Weight (kg)"
                type="number"
                value={weightKg}
                onChange={setWeightKg}
                min={0.1}
                // The browser only accepts min + n × step: 0.5 made 1 kg invalid.
                step={0.1}
                autoComplete="off"
              />
            </InlineStack>
            {bwsMissing.length > 0 && (
              <Banner tone="warning">Missing server settings: {bwsMissing.join(", ")}</Banner>
            )}
          </BlockStack>
        )}

        <Divider />

        {/* ── Print shop ── */}
        {sheet.sentToPrintShopAt && !showResend ? (
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <BlockStack gap="050">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Sent to print shop
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {sheet.sentToPrintShopTo} · {formatDateTime(sheet.sentToPrintShopAt)}
              </Text>
            </BlockStack>
            <Button variant="plain" onClick={() => setShowResend(true)}>
              Send again
            </Button>
          </InlineStack>
        ) : (
          <BlockStack gap="300">
            <TextField
              label="Send to print shop"
              value={to}
              onChange={setTo}
              autoComplete="off"
              helpText="Files, label and order details, in Polish and English. Several addresses: separate with commas."
            />
            <TextField
              label="Message (optional)"
              value={message}
              onChange={setMessage}
              multiline={2}
              autoComplete="off"
            />
            {!booked && (
              <Checkbox
                label="Book the BWS pickup first (choices above)"
                checked={bookToo}
                onChange={setBookToo}
              />
            )}
            {sheet.productionMailSentAt ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Customer was told production started · {formatDateTime(sheet.productionMailSentAt)}
              </Text>
            ) : (
              <Checkbox
                label="Email the customer that production has started"
                helpText={shipping.printShop.customerEmail || "No customer email on this order"}
                checked={notify && Boolean(shipping.printShop.customerEmail)}
                disabled={!shipping.printShop.customerEmail}
                onChange={setNotify}
              />
            )}
            {mailMissing.length > 0 && (
              <Banner tone="warning" title="Email is not set up yet">
                Missing server settings: {mailMissing.join(", ")}
              </Banner>
            )}
          </BlockStack>
        )}

        {errors && !busy && (
          <Banner tone="critical" title="Not done">
            <BlockStack gap="100">
              {errors.map((e) => (
                <Text as="p" variant="bodySm" key={e}>
                  {e}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}
        {fetcher.data?.notice && !busy && <Banner tone="success">{fetcher.data.notice}</Banner>}

        {(!sheet.sentToPrintShopAt || showResend) && (
          <BlockStack gap="200">
            <Button
              variant="primary"
              fullWidth
              loading={busy}
              disabled={
                busy ||
                !to.includes("@") ||
                mailMissing.length > 0 ||
                (willBook && bwsMissing.length > 0)
              }
              onClick={() => submit("send_print_shop")}
            >
              {willBook ? "Book pickup & send to print shop" : showResend ? "Send again" : "Send to print shop"}
            </Button>
            {!booked && (
              <Button
                variant="plain"
                disabled={busy || bwsMissing.length > 0}
                onClick={() => submit("book_bws")}
              >
                Book pickup only
              </Button>
            )}
          </BlockStack>
        )}

        {/* ── Tracking to the customer ── */}
        {booked && (
          <>
            <Divider />
            {sheet.shopifyFulfillmentId ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Customer got the shipping email with tracking.
              </Text>
            ) : (
              <trackingFetcher.Form method="post">
                <input type="hidden" name="action" value="send_tracking" />
                <BlockStack gap="200">
                  {sheet.fulfillmentError || trackingFetcher.data?.errors ? (
                    <Banner tone="critical" title="Customer has not received tracking">
                      {trackingFetcher.data?.errors?.join(" · ") || sheet.fulfillmentError}
                    </Banner>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      The customer gets the shipping email with tracking at pickup
                      {sheet.pickupDate ? `, ${sheet.pickupDate} ${shipping.pickupFrom}` : ""}.
                    </Text>
                  )}
                  <InlineStack>
                    <Button submit variant="plain" loading={trackingFetcher.state !== "idle"}>
                      Send tracking now
                    </Button>
                  </InlineStack>
                </BlockStack>
              </trackingFetcher.Form>
            )}
          </>
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

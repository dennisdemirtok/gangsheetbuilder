/**
 * BWS (Blue Water Shipping) — ShippingOrders API v2.
 *
 * Our subscription only covers the ShippingOrders product; the Bookings API
 * answers 401 with the same key. One POST books the pickup AND returns the
 * labels (base64) and tracking numbers, so there is no second call.
 *
 * Test API: https://api-test.bws.net/shipping/api/v2  (portal integration-test.bws.net)
 * Prod API: https://api.bws.net/shipping/api/v2       (portal integration.bws.net)
 *
 * ClientId is our AX customer number at BWS (181751, Bigsam AB — the number
 * on every BWS invoice), NOT a portal id.
 *
 * The normal job: one courier pickup at the print shop in Poland, DDP, one
 * 60×5×5 cm tube, 1 kg (heavier only for very long orders).
 */

const BWS_BASE_URL =
  process.env.BWS_API_URL || "https://api-test.bws.net/shipping/api/v2";
const BWS_API_KEY = process.env.BWS_API_KEY || "";
const BWS_CLIENT_ID = process.env.BWS_CLIENT_ID || "181751";
/** Optional ServiceType code (EXP, ECO, …). Unset = BWS picks from the customer's booking settings. */
const BWS_SERVICE = process.env.BWS_SERVICE || "";

/**
 * Test-only stand-in for a successful booking, so the label download and the
 * customer's tracking email can be tried before BWS has activated our
 * customer in their test system. Ignored against the production API.
 */
const BWS_SIMULATE = process.env.BWS_SIMULATE === "true";
export const SIMULATED_PREFIX = "SIM-";

/** Pickups are booked in Polish local time. */
const PICKUP_TIMEZONE = "Europe/Warsaw";
const PICKUP_FROM = process.env.BWS_PICKUP_FROM || "11:30";
const PICKUP_UNTIL = process.env.BWS_PICKUP_UNTIL || "16:00";
export const PICKUP_TIME = PICKUP_FROM;

export const PACKAGE_CM = { length: 60, width: 5, height: 5 } as const;

export function getPickupAddress(): BwsAddress {
  return {
    name: process.env.BWS_PICKUP_NAME || "TransferCraft",
    address1: process.env.BWS_PICKUP_ADDRESS || "",
    address2: process.env.BWS_PICKUP_ADDRESS2 || "",
    zip: process.env.BWS_PICKUP_ZIP || "",
    city: process.env.BWS_PICKUP_CITY || "",
    countryCode: process.env.BWS_PICKUP_COUNTRY || "PL",
    phone: process.env.BWS_PICKUP_PHONE || "",
    email: process.env.BWS_PICKUP_EMAIL || "",
    contact: process.env.BWS_PICKUP_CONTACT || "",
  };
}

export interface BwsAddress {
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  zip: string;
  city: string;
  countryCode: string;
  phone?: string;
  email?: string;
  contact?: string;
}

export interface BwsShipmentInput {
  /** Shown on the label and used to find the booking at BWS, e.g. "#1002". */
  reference: string;
  recipient: BwsAddress;
  /** Local date in Poland, YYYY-MM-DD. */
  pickupDate: string;
  weightKg: number;
  valueSEK: number;
  description?: string;
}

export interface BwsLabel {
  data: Buffer;
  contentType: string;
  extension: string;
}

export interface BwsShipmentResult {
  success: boolean;
  /** True when the booking was faked by BWS_SIMULATE (test API only). */
  simulated?: boolean;
  bookingId?: string;
  trackingNumbers: string[];
  trackingUrl?: string;
  label?: BwsLabel;
  errors: string[];
  requestBody: unknown;
  rawResponse?: unknown;
}

/**
 * Film weight scales with length, but a normal order is just the tube.
 * ≤50 m → 1 kg, ≤100 m → 2 kg, longer → 3 kg.
 */
export function weightForMeters(meters: number): number {
  if (meters <= 50) return 1;
  if (meters <= 100) return 2;
  return 3;
}

/** "YYYY-MM-DD" and "HH:MM" for an instant, as seen in `timeZone`. */
function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday as string,
  };
}

/** UTC instant for a wall-clock time in `timeZone` (handles DST). */
function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const seen = localParts(guess, timeZone);
  const seenAsUtc = new Date(`${seen.date}T${seen.time}:00Z`);
  return new Date(guess.getTime() - (seenAsUtc.getTime() - guess.getTime()));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Today in Poland if it is a weekday and still before the pickup time,
 * otherwise the next weekday. The admin can override it per booking.
 */
export function defaultPickupDate(now: Date = new Date()): string {
  const local = localParts(now, PICKUP_TIMEZONE);
  let date = local.date;
  if (local.time >= PICKUP_FROM) date = addDays(date, 1);
  for (;;) {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return date;
    date = addDays(date, 1);
  }
}

export function missingPickupConfig(): string[] {
  const a = getPickupAddress();
  const missing: string[] = [];
  if (!BWS_API_KEY) missing.push("BWS_API_KEY");
  if (!a.address1) missing.push("BWS_PICKUP_ADDRESS");
  if (!a.zip) missing.push("BWS_PICKUP_ZIP");
  if (!a.city) missing.push("BWS_PICKUP_CITY");
  if (!a.phone) missing.push("BWS_PICKUP_PHONE");
  return missing;
}

export function isBwsTestEnvironment(): boolean {
  return BWS_BASE_URL.includes("api-test");
}

export function isSimulationEnabled(): boolean {
  return BWS_SIMULATE && isBwsTestEnvironment();
}

function toBwsAddress(a: BwsAddress) {
  return {
    Name: a.company || a.name,
    AddressLine1: a.address1,
    AddressLine2: a.address2 || null,
    ZipCode: a.zip,
    City: a.city,
    CountryCode: a.countryCode,
    Phone: a.phone || null,
    Email: a.email || null,
    Att: a.contact || (a.company ? a.name : null),
    Contact: a.contact || (a.company ? a.name : null),
  };
}

export function buildShippingOrder(input: BwsShipmentInput) {
  const pickup = getPickupAddress();
  const from = zonedToUtc(input.pickupDate, PICKUP_FROM, PICKUP_TIMEZONE);
  const until = zonedToUtc(input.pickupDate, PICKUP_UNTIL, PICKUP_TIMEZONE);
  const value = { Value: input.valueSEK, Currency: "Sek" };
  const pickupAddress = toBwsAddress(pickup);
  const recipient = toBwsAddress(input.recipient);

  return {
    MessageIdentification: {
      ClientId: BWS_CLIENT_ID,
      Operation: "Create",
      ReceiverId: null,
      SenderId: null,
      TourNumber: null,
    },
    EstimatedDeparture: from.toISOString(),
    Comments: `TransferCraft ${input.reference}`,
    ReceiverPays: false,
    Consignments: [
      {
        ConsignmentIdentification: {
          ConsignorsReferenceNumber: input.reference,
          ConsigneesShipmentReferenceNumber: null,
          CustomersReferenceNumber: input.reference,
          BookingReference: null,
          AgentReferenceNumber: null,
        },
        ConsignmentNumber: 1,
        ...(BWS_SERVICE ? { Service: BWS_SERVICE } : {}),
        TotalValue: value,
        Pickup: {
          Mode: "WithinDateTimeInterval",
          FromDateTime: from.toISOString(),
          ToDateTime: until.toISOString(),
        },
        TransportDetails: { Mode: "Courier", QuoteType: "Export" },
        Addresses: {
          ConsignorAddress: pickupAddress,
          DespatchPartyAddress: pickupAddress,
          ConsigneeAddress: recipient,
          DeliveryPartyAddress: recipient,
        },
        Incoterms: { Code: "DDP", City: null },
        Lines: [
          {
            LineNumber: 1,
            LineReference: input.reference,
            Description: input.description || "DTF transfers (printed film)",
            Quantity: 1,
            UnitType: "Package",
            UnitDimensions: {
              Length: PACKAGE_CM.length,
              Width: PACKAGE_CM.width,
              Height: PACKAGE_CM.height,
              Unit: "CentiMeter",
            },
            TotalGrossWeight: { Value: input.weightKg, Unit: "Kilogram" },
            TotalValue: value,
          },
        ],
        LinesAreTotals: true,
        AdditionalServices: {
          BusinessToCustomer: !input.recipient.company,
        },
      },
    ],
  };
}

/** Labels come back base64 without a declared type; sniff it. */
export function decodeLabel(base64: string): BwsLabel {
  const data = Buffer.from(base64, "base64");
  const head = data.subarray(0, 8).toString("latin1");
  if (head.startsWith("%PDF")) {
    return { data, contentType: "application/pdf", extension: "pdf" };
  }
  if (head.startsWith("\x89PNG")) {
    return { data, contentType: "image/png", extension: "png" };
  }
  if (head.startsWith("GIF8")) {
    return { data, contentType: "image/gif", extension: "gif" };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    return { data, contentType: "image/jpeg", extension: "jpg" };
  }
  // ZPL/EPL for thermal printers is plain text.
  return { data, contentType: "text/plain", extension: "zpl" };
}

export function parseShippingOrderResponse(
  status: number,
  body: any,
): Omit<BwsShipmentResult, "requestBody"> {
  const errors: string[] = [
    ...(Array.isArray(body?.ErrorMessage) ? body.ErrorMessage : []),
    ...(Array.isArray(body?.ErrorMessages) ? body.ErrorMessages : []),
    ...(typeof body?.message === "string" ? [body.message] : []),
  ].filter(Boolean);

  const units: any[] = Array.isArray(body?.Units) ? body.Units : [];
  const trackingNumbers = units
    .map((u) => u?.TrackingNumber)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  const labelBase64: string | undefined =
    body?.Consolidated64BaseLabel || units.find((u) => u?.LabelBase64Data)?.LabelBase64Data;

  const success = status >= 200 && status < 300 && body?.IsSuccess === true;
  if (!success && errors.length === 0) {
    errors.push(body?.Status || `BWS answered ${status}`);
  }

  return {
    success,
    bookingId: body?.BookingId || body?.InternalOrderId || undefined,
    trackingNumbers,
    trackingUrl: body?.TrackingUrl || units[0]?.TrackingURL || undefined,
    label: labelBase64 ? decodeLabel(labelBase64) : undefined,
    errors,
    rawResponse: body,
  };
}

export async function createBwsShipment(
  input: BwsShipmentInput,
): Promise<BwsShipmentResult> {
  const requestBody = buildShippingOrder(input);

  const missing = missingPickupConfig();
  if (missing.length > 0) {
    return {
      success: false,
      trackingNumbers: [],
      errors: [`Missing settings: ${missing.join(", ")}`],
      requestBody,
    };
  }

  try {
    const response = await fetch(`${BWS_BASE_URL}/shippingOrders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": BWS_API_KEY,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { Status: text.slice(0, 500) };
    }

    const result = parseShippingOrderResponse(response.status, body);
    if (!result.success && isSimulationEnabled()) {
      console.warn(`[BWS] Simulating ${input.reference}; BWS said:`, result.errors);
      return { ...simulateShipment(input, result.errors), requestBody };
    }
    if (result.success) {
      console.log(`[BWS] Booked ${input.reference}: ${result.bookingId}`);
    } else {
      console.error(`[BWS] Booking ${input.reference} failed:`, result.errors);
    }
    return { ...result, requestBody };
  } catch (error) {
    console.error("[BWS] Request failed:", error);
    return {
      success: false,
      trackingNumbers: [],
      errors: [`Could not reach BWS: ${(error as Error).message}`],
      requestBody,
    };
  }
}

function simulateShipment(
  input: BwsShipmentInput,
  bwsErrors: string[],
): Omit<BwsShipmentResult, "requestBody"> {
  const stamp = Date.now().toString().slice(-8);
  const trackingNumber = `${SIMULATED_PREFIX}${stamp}`;
  const pickup = getPickupAddress();
  const r = input.recipient;
  const lines = [
    "SIMULATED LABEL - NOT A REAL BWS BOOKING",
    `BWS test answered: ${(bwsErrors[0] || "").slice(0, 40)}`,
    "",
    `Reference: ${input.reference}`,
    `Tracking: ${trackingNumber}`,
    `Pickup: ${input.pickupDate} ${PICKUP_FROM}-${PICKUP_UNTIL} (Poland)`,
    `Package: ${PACKAGE_CM.length}x${PACKAGE_CM.width}x${PACKAGE_CM.height} cm, ${input.weightKg} kg, DDP`,
    "",
    "FROM",
    pickup.name,
    pickup.address1,
    `${pickup.zip} ${pickup.city}, ${pickup.countryCode}`,
    "",
    "TO",
    ...(r.company ? [r.company] : []),
    r.name,
    r.address1,
    ...(r.address2 ? [r.address2] : []),
    `${r.zip} ${r.city}, ${r.countryCode}`,
  ];
  return {
    success: true,
    simulated: true,
    bookingId: `${SIMULATED_PREFIX}BOOKING-${stamp}`,
    trackingNumbers: [trackingNumber],
    label: {
      data: textPdf(lines),
      contentType: "application/pdf",
      extension: "pdf",
    },
    errors: [],
  };
}

/** One-page A6 PDF with Helvetica text lines; enough for a stand-in label. */
function textPdf(lines: string[]): Buffer {
  // WinAnsi covers Polish/Swedish letters poorly; transliterate to keep it valid.
  const clean = (t: string) =>
    t
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[łŁ]/g, (c) => (c === "ł" ? "l" : "L"))
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/([\\()])/g, "\\$1");
  const content = [
    "BT /F1 9 Tf 12 TL 20 400 Td",
    ...lines.map((l) => `(${clean(l)}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

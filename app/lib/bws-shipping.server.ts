/**
 * BWS (Blue Water Shipping) API integration.
 *
 * Endpoint: https://api.bws.net/shipping/api/v2/shippingOrders
 * Auth: Ocp-Apim-Subscription-Key header
 * Content-Type: application/json-patch+json
 * ClientId: 180123
 */

// Test: https://api-test.bws.net/shipping/api/v2
// Prod: https://b2bapi.bws.dk/api/v2
const BWS_BASE_URL = process.env.BWS_API_URL || "https://api-test.bws.net/shipping/api/v2";
const BWS_API_KEY = process.env.BWS_API_KEY || "";
const BWS_CLIENT_ID = parseInt(process.env.BWS_CLIENT_ID || "180123");

export interface BwsShipmentInput {
  // Sender (TransferCraft / printing partner)
  senderName: string;
  senderAddress: string;
  senderZip: string;
  senderCity: string;
  senderCountry: string;
  senderPhone?: string;
  senderEmail?: string;

  // Recipient (customer)
  recipientName: string;
  recipientAddress: string;
  recipientZip: string;
  recipientCity: string;
  recipientCountry: string;
  recipientPhone?: string;
  recipientEmail?: string;

  // Package details
  description: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;

  // Reference
  orderReference: string;
  totalValueSEK: number;

  // Options
  service?: string; // e.g. "EXP" for express
  deliveryInstruction?: string;
}

export interface BwsShipmentResponse {
  success: boolean;
  transactionId?: string;
  trackingNumber?: string;
  labelUrl?: string;
  error?: string;
  rawResponse?: any;
}

/**
 * Create a shipping order via BWS API.
 * Uses the exact schema from BWS ShippingOrders endpoint.
 */
export async function createBwsShipment(
  input: BwsShipmentInput,
): Promise<BwsShipmentResponse> {
  if (!BWS_API_KEY) {
    console.warn("[BWS] No API key configured. Set BWS_API_KEY in .env");
    return { success: false, error: "BWS API key not configured" };
  }

  const now = new Date();
  const departure = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 day
  const arrival = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // +3 days

  const body = {
    MessageIdentification: {
      ClientId: BWS_CLIENT_ID,
      Operation: "Create",
      ReceiverId: null,
      SenderId: null,
      TourNumber: null,
    },
    EstimatedDeparture: departure.toISOString(),
    EstimatedArrival: arrival.toISOString(),
    Comments: `TransferCraft DTF Transfer — ${input.orderReference}`,
    ReceiverPays: false,
    Consignments: [
      {
        ConsignmentIdentification: {
          ConsignorsReferenceNumber: input.orderReference,
          CustomersReferenceNumber: input.orderReference,
          BookingReference: input.orderReference,
        },
        ConsignmentNumber: 1,
        Service: input.service || "STD",
        TotalValue: {
          Value: input.totalValueSEK,
          Currency: "SEK",
        },
        DeliveryInstructions: input.deliveryInstruction
          ? [{ Instruction: input.deliveryInstruction }]
          : [],
        TransportDetails: {
          Mode: "Road",
        },
        Addresses: {
          ConsignorAddress: {
            Name: input.senderName,
            AddressLine1: input.senderAddress,
            ZipCode: input.senderZip,
            City: input.senderCity,
            CountryCode: input.senderCountry,
            Phone: input.senderPhone || "",
            Email: input.senderEmail || "",
          },
          ConsigneeAddress: {
            Name: input.recipientName,
            AddressLine1: input.recipientAddress,
            ZipCode: input.recipientZip,
            City: input.recipientCity,
            CountryCode: input.recipientCountry,
            Phone: input.recipientPhone || "",
            Email: input.recipientEmail || "",
          },
          DeliveryPartyAddress: {
            Name: input.recipientName,
            AddressLine1: input.recipientAddress,
            ZipCode: input.recipientZip,
            City: input.recipientCity,
            CountryCode: input.recipientCountry,
            Phone: input.recipientPhone || "",
            Email: input.recipientEmail || "",
          },
        },
        Incoterms: {
          Code: "DAP",
          City: null,
        },
        Lines: [
          {
            LineNumber: 1,
            Description: input.description,
            Quantity: 1,
            UnitType: "Parcel",
            UnitDimensions: {
              Length: input.lengthCm / 100, // BWS uses meters
              Height: input.heightCm / 100,
              Width: input.widthCm / 100,
              Unit: "Meter",
            },
            TotalGrossWeight: {
              Value: input.weightKg,
              Unit: "Kilogram",
            },
            TotalNetWeight: {
              Value: Math.max(0.1, input.weightKg - 0.1),
              Unit: "Kilogram",
            },
            TotalValue: {
              Value: input.totalValueSEK,
              Currency: "SEK",
            },
          },
        ],
        LinesAreTotals: true,
        AdditionalServices: {
          BusinessToCustomer: true,
        },
      },
    ],
  };

  try {
    console.log("[BWS] Creating shipment for:", input.orderReference);

    const response = await fetch(`${BWS_BASE_URL}/shippingOrders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json-patch+json",
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": BWS_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let responseData: any = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (!response.ok) {
      console.error("[BWS] Error:", response.status, responseData);
      return {
        success: false,
        error: `BWS ${response.status}: ${JSON.stringify(responseData)}`,
        rawResponse: responseData,
      };
    }

    console.log("[BWS] Shipment created:", responseData);

    return {
      success: true,
      transactionId: responseData?.TransactionId || responseData?.Id,
      trackingNumber: responseData?.TrackingNumber,
      labelUrl: responseData?.LabelUrl,
      rawResponse: responseData,
    };
  } catch (error) {
    console.error("[BWS] Request failed:", error);
    return {
      success: false,
      error: `BWS request failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Calculate estimated weight for a gang sheet.
 * DTF film: ~200g/m², packaging: ~300g
 */
export function estimateWeight(
  widthMm: number,
  heightMm: number,
  quantity: number = 1,
): number {
  const areaSqM = (widthMm / 1000) * (heightMm / 1000);
  const filmWeight = areaSqM * 0.2 * quantity;
  const packaging = 0.3;
  return Math.round((filmWeight + packaging) * 100) / 100;
}

/**
 * Estimate package dimensions for a rolled DTF sheet.
 * Sheets are rolled into tubes.
 */
export function estimatePackageDimensions(widthMm: number): {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
} {
  return {
    lengthCm: Math.ceil(widthMm / 10) + 4, // sheet width + padding
    widthCm: 10, // tube diameter
    heightCm: 10,
  };
}

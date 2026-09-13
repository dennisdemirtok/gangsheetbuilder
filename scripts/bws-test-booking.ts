/**
 * Sends one real booking to the BWS API configured in the environment,
 * through the same code the admin uses. Point BWS_API_URL at the TEST API.
 *
 *   BWS_API_KEY=... npx tsx scripts/bws-test-booking.ts
 */
import {
  buildShippingOrder,
  createBwsShipment,
  defaultPickupDate,
  isBwsTestEnvironment,
} from "../app/lib/bws-shipping.server";

if (!isBwsTestEnvironment()) {
  console.error("Refusing to run: BWS_API_URL is not the test API.");
  process.exit(1);
}

const input = {
  reference: "TEST-1001",
  pickupDate: defaultPickupDate(),
  weightKg: 1,
  valueSEK: 250,
  recipient: {
    name: "Test Kund",
    address1: "Förrådsgatan 8",
    zip: "85633",
    city: "Sundsvall",
    countryCode: "SE",
    phone: "+46704411710",
    email: "dennis@transfercraft.com",
  },
};

console.log("Request:", JSON.stringify(buildShippingOrder(input), null, 2));
const result = await createBwsShipment(input);
console.log("Result:", {
  success: result.success,
  bookingId: result.bookingId,
  trackingNumbers: result.trackingNumbers,
  trackingUrl: result.trackingUrl,
  label: result.label && `${result.label.contentType}, ${result.label.data.length} bytes`,
  errors: result.errors,
});

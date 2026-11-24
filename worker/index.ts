import { Worker } from "bullmq";
import IORedis from "ioredis";
import { exportGangSheetJob } from "./jobs/export-gang-sheet";
import { removeBackgroundJob } from "./jobs/remove-background";
import { cleanupExpiredJob } from "./jobs/cleanup-expired";
import { fulfillDuePickups } from "../app/lib/order-shipment.server";
import { fulfillDueGarmentPickups } from "../app/lib/garment-shipment.server";
import { sweepMissedDeliveries } from "../app/lib/missed-delivery.server";
import { sendStuckShipmentDigest, stockholmClock, DIGEST_HOUR } from "../app/lib/stuck-shipments.server";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error(
    "[worker] REDIS_URL is not set — worker cannot start. " +
      "Set REDIS_URL to enable background export/bg-removal/cleanup jobs. " +
      "Exiting worker only; the web server is unaffected.",
  );
  process.exit(0);
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

console.log("Starting Gang Sheet Builder workers...");

// Export worker
const exportWorker = new Worker(
  "gangsheet-export",
  async (job) => {
    console.log(`[export] Processing job ${job.id}: ${job.data.gangSheetId}`);
    await exportGangSheetJob(job.data);
    console.log(`[export] Completed job ${job.id}`);
  },
  {
    connection,
    // Keep at 1 — a 58×500cm sheet at 300 DPI is ~404 megapixels; parallel
    // exports would exhaust container memory.
    concurrency: 1,
  },
);

exportWorker.on("failed", (job, err) => {
  console.error(`[export] Job ${job?.id} failed:`, err);
});

// Background removal worker
const bgRemovalWorker = new Worker(
  "bg-removal",
  async (job) => {
    console.log(`[bg-removal] Processing job ${job.id}: ${job.data.imageId}`);
    await removeBackgroundJob(job.data);
    console.log(`[bg-removal] Completed job ${job.id}`);
  },
  {
    connection,
    concurrency: 3,
  },
);

bgRemovalWorker.on("failed", (job, err) => {
  console.error(`[bg-removal] Job ${job?.id} failed:`, err);
});

// Cleanup worker
const cleanupWorker = new Worker(
  "cleanup",
  async (job) => {
    console.log(`[cleanup] Processing job ${job.id}`);
    await cleanupExpiredJob(job.data);
    console.log(`[cleanup] Completed job ${job.id}`);
  },
  {
    connection,
    concurrency: 1,
  },
);

cleanupWorker.on("failed", (job, err) => {
  console.error(`[cleanup] Job ${job?.id} failed:`, err);
});

/*
 * Shipping confirmations: every 5 minutes, fulfil in Shopify the orders
 * whose BWS courier has come (pickup time passed), which sends the customer
 * Shopify's shipping email with the tracking link.
 */
const TRACKING_SWEEP_MS = 5 * 60 * 1000;
let sweeping = false;
async function sweepTracking() {
  if (sweeping) return;
  sweeping = true;
  try {
    const sent = await fulfillDuePickups();
    if (sent > 0) console.log(`[tracking] Sent shipping confirmation for ${sent} order(s)`);
    // Clothes collected at Printgood: their own parcel and tracking.
    const garments = await fulfillDueGarmentPickups();
    if (garments > 0) console.log(`[tracking] Sent garment tracking for ${garments} order(s)`);
  } catch (err) {
    console.error("[tracking] Sweep failed:", err);
  } finally {
    sweeping = false;
  }
}
const trackingTimer = setInterval(sweepTracking, TRACKING_SWEEP_MS);
setTimeout(sweepTracking, 30_000);

/*
 * Missed deliveries: every hour, look up the carrier's events on shipped
 * orders. A failed delivery attempt still not delivered by 08:00 the next
 * day emails the customer to rebook (see missed-delivery.server.ts).
 */
const DELIVERY_SWEEP_MS = 60 * 60 * 1000;
let checkingDeliveries = false;
async function sweepDeliveries() {
  if (checkingDeliveries) return;
  checkingDeliveries = true;
  try {
    const results = await sweepMissedDeliveries();
    for (const r of results) {
      if (r.action === "send" || r.action === "error" || r.action === "delivered") {
        console.log(`[delivery] ${r.order}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
      }
    }
  } catch (err) {
    console.error("[delivery] Sweep failed:", err);
  } finally {
    checkingDeliveries = false;
  }
}
const deliveryTimer = setInterval(sweepDeliveries, DELIVERY_SWEEP_MS);
setTimeout(sweepDeliveries, 90_000);

/*
 * Parcels without a carrier scan: on weekdays from 08:00 (Stockholm), once a
 * day, email the shop the orders booked 2+ days ago that FedEx never scanned
 * (see stuck-shipments.server.ts). A Redis key per day keeps restarts and a
 * second worker from sending it twice.
 */
const STUCK_CHECK_MS = 15 * 60 * 1000;
let checkingStuck = false;
async function stuckShipmentDigest() {
  if (checkingStuck) return;
  const clock = stockholmClock(new Date());
  if (!clock.weekday || clock.hour < DIGEST_HOUR) return;
  checkingStuck = true;
  const key = `stuck-shipment-digest:${clock.day}`;
  try {
    const claimed = await connection.set(key, new Date().toISOString(), "EX", 3 * 24 * 60 * 60, "NX");
    if (claimed !== "OK") return;
    try {
      const { check, sent } = await sendStuckShipmentDigest();
      console.log(
        `[stuck] ${check.checked} checked, ${check.stuck.length} to check` +
          `${check.stuck.length ? ` (${check.stuck.map((s) => s.order).join(", ")})` : ""}` +
          `${check.errors.length ? `, ${check.errors.length} error(s)` : ""}${sent ? ", emailed" : ""}`,
      );
    } catch (err) {
      // Not sent: free the day so the next check tries again.
      await connection.del(key);
      throw err;
    }
  } catch (err) {
    console.error("[stuck] Digest failed:", err);
  } finally {
    checkingStuck = false;
  }
}
const stuckTimer = setInterval(stuckShipmentDigest, STUCK_CHECK_MS);
setTimeout(stuckShipmentDigest, 120_000);

console.log("Workers started successfully.");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down workers...");
  clearInterval(trackingTimer);
  clearInterval(deliveryTimer);
  clearInterval(stuckTimer);
  await Promise.all([
    exportWorker.close(),
    bgRemovalWorker.close(),
    cleanupWorker.close(),
  ]);
  await connection.quit();
  process.exit(0);
});

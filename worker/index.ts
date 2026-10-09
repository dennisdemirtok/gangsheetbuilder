import { Worker } from "bullmq";
import IORedis from "ioredis";
import { exportGangSheetJob } from "./jobs/export-gang-sheet";
import { removeBackgroundJob } from "./jobs/remove-background";
import { cleanupExpiredJob } from "./jobs/cleanup-expired";
import { fulfillDuePickups } from "../app/lib/order-shipment.server";
import { sweepMissedDeliveries } from "../app/lib/missed-delivery.server";

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

console.log("Workers started successfully.");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down workers...");
  clearInterval(trackingTimer);
  clearInterval(deliveryTimer);
  await Promise.all([
    exportWorker.close(),
    bgRemovalWorker.close(),
    cleanupWorker.close(),
  ]);
  await connection.quit();
  process.exit(0);
});

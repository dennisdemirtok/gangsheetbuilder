import { Worker } from "bullmq";
import IORedis from "ioredis";
import { exportGangSheetJob } from "./jobs/export-gang-sheet";
import { removeBackgroundJob } from "./jobs/remove-background";
import { cleanupExpiredJob } from "./jobs/cleanup-expired";

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

console.log("Workers started successfully.");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down workers...");
  await Promise.all([
    exportWorker.close(),
    bgRemovalWorker.close(),
    cleanupWorker.close(),
  ]);
  await connection.quit();
  process.exit(0);
});

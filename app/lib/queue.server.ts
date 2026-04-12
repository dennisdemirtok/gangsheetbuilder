import { Queue } from "bullmq";
import IORedis from "ioredis";

let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!connection) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL environment variable is not set");
    }
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

// Queue for generating final 300 DPI export files
export function getExportQueue(): Queue {
  return new Queue("gangsheet-export", {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });
}

// Queue for background removal jobs
export function getBgRemovalQueue(): Queue {
  return new Queue("bg-removal", {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });
}

// Queue for GDPR cleanup jobs
export function getCleanupQueue(): Queue {
  return new Queue("cleanup", {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  });
}

export interface ExportJobData {
  gangSheetId: string;
  shopDomain: string;
}

export interface BgRemovalJobData {
  imageId: string;
  originalUrl: string;
  r2Key: string;
}

export interface CleanupJobData {
  type: "images" | "exports";
  olderThanDays: number;
  shopDomain?: string;
}

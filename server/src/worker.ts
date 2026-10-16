import { UnrecoverableError, Worker } from "bullmq";
import { closeQueues } from "./queues/queues.js";
import { closeRedisConnections, workerRedisConnection } from "./lib/redis/redis.client.js";
import { JOB_NAMES, QUEUE_NAMES } from "./queues/queue-names.js";
import type { JobAttemptJobData, WebhookJobData } from "./queues/queues.js";
import { processGithubWebhookDelivery } from "./services/github/github-webhook.service.js";
import { processJobAttempt } from "./workers/job-attempt.worker.js";
import { startOutboxWorker, stopOutboxWorker } from "./workers/outbox.worker.js";
import { closeLogStorage } from "./services/logs/log-chunk.service.js";
import { closeS3Storage } from "./storage/s3.service.js";
import { AppError } from "./utils/app.error.js";

const asWorkerError = (error: unknown): never => {
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    throw new UnrecoverableError(error.message);
  }
  throw error;
};

const webhookWorker = new Worker<WebhookJobData>(
  QUEUE_NAMES.webhook,
  async (job) => {
    if (job.name !== JOB_NAMES.githubWebhook) {
      throw new UnrecoverableError(`Unsupported webhook job name: ${job.name}`);
    }
    const id = job.data?.webhookDeliveryId;
    if (typeof id !== "string" || id.length === 0) {
      throw new UnrecoverableError("Invalid webhook queue payload");
    }
    try {
      await processGithubWebhookDelivery(id);
    } catch (error) {
      asWorkerError(error);
    }
  },
  { connection: workerRedisConnection, concurrency: 5 },
);

const jobAttemptWorker = new Worker<JobAttemptJobData>(
  QUEUE_NAMES.jobAttempt,
  async (job) => {
    if (job.name !== JOB_NAMES.jobAttempt) {
      throw new UnrecoverableError(`Unsupported job-attempt job name: ${job.name}`);
    }
    try {
      await processJobAttempt(job);
    } catch (error) {
      asWorkerError(error);
    }
  },
  { connection: workerRedisConnection, concurrency: 3 },
);

for (const [name, worker] of [["webhook", webhookWorker], ["job-attempt", jobAttemptWorker]] as const) {
  worker.on("error", (error) => console.error(`[${name}] worker error`, error));
  worker.on("failed", (job, error) => console.error(`[${name}] job failed`, { jobId: job?.id, name: job?.name, error }));
  worker.on("stalled", (jobId) => console.error(`[${name}] job stalled`, jobId));
}

// The outbox is the bridge from committed PostgreSQL work to BullMQ. Without
// this loop, webhook deliveries and job attempts remain pending in the DB.
void startOutboxWorker();

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`DeployBench worker received ${signal}; shutting down`);
  stopOutboxWorker();
  await Promise.allSettled([
    webhookWorker.close(),
    jobAttemptWorker.close(),
    closeQueues(),
  ]);
  closeLogStorage();
  closeS3Storage();
  await closeRedisConnections();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

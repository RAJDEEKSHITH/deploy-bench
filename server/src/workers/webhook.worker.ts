import { Worker } from "bullmq";

import {
  workerRedisConnection,
} from "../lib/redis/redis.client.js";

import {
  JOB_NAMES,
  QUEUE_NAMES,
} from "../queues/queue-names.js";

import type {
  WebhookJobData,
} from "../queues/queues.js";

import {
  processGithubWebhookDelivery,
} from "../services/github/github-webhook.service.js";

export const webhookWorker =
  new Worker<WebhookJobData>(
    QUEUE_NAMES.webhook,
    async (job) => {
      await processGithubWebhookDelivery(
        job.data.webhookDeliveryId,
      );
    },
    {
      connection:
        workerRedisConnection,

      concurrency: 5,
    },
  );

webhookWorker.on(
  "error",
  (error) => {
    console.error(
      "Webhook worker error:",
      error,
    );
  },
);

webhookWorker.on(
  "failed",
  (job, error) => {
    console.error(
      "Webhook job failed",
      {
        jobId: job?.id,
        error,
      },
    );
  },
);

webhookWorker.on(
  "stalled",
  (jobId) => {
    console.error(
      "Webhook job stalled",
      jobId,
    );
  },
);

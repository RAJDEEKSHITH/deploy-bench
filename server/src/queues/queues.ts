import { Queue } from "bullmq";

import { redisConnection } from "../lib/redis/redis.client.js";

import {
  QUEUE_NAMES,
} from "./queue-names.js";

export type WebhookJobData = {
  webhookDeliveryId: string;
};

export type JobAttemptJobData = {
  jobAttemptId: string;
};

export type DeploymentJobData = {
  deploymentId: string;
};

const defaultJobOptions = {
  /*
   * PostgreSQL is the durable source of truth.
   * Keep a bounded amount of BullMQ history for operations/debugging.
   */
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

export const webhookQueue =
  new Queue<WebhookJobData>(
    QUEUE_NAMES.webhook,
    {
      connection: redisConnection,
      defaultJobOptions,
    },
  );

export const jobAttemptQueue =
  new Queue<JobAttemptJobData>(
    QUEUE_NAMES.jobAttempt,
    {
      connection: redisConnection,
      defaultJobOptions,
    },
  );

export const deploymentQueue =
  new Queue<DeploymentJobData>(
    QUEUE_NAMES.deployment,
    {
      connection: redisConnection,
      defaultJobOptions,
    },
  );

export const closeQueues =
  async (): Promise<void> => {
    await Promise.all([
      webhookQueue.close(),
      jobAttemptQueue.close(),
      deploymentQueue.close(),
    ]);
  };
import {
  and,
  asc,
  eq,
  isNull,
  lte,
  or,
} from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { db } from "../../db/index.js";

import { outboxMessages } from "../../db/schema.js";

import {
  deploymentQueue,
  jobAttemptQueue,
  webhookQueue,
} from "../../queues/queues.js";

import {
  JOB_NAMES,
  QUEUE_NAMES,
} from "../../queues/queue-names.js";

const LEASE_DURATION_MS = 60_000;
const CANDIDATE_LIMIT = 20;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type OutboxRow =
  typeof outboxMessages.$inferSelect;

type ClaimedMessage = Pick<
  OutboxRow,
  | "id"
  | "messageType"
  | "payload"
  | "queueName"
  | "attemptCount"
  | "leaseToken"
>;

const getErrorMessage = (
  error: unknown,
): string => {
  if (error instanceof Error) {
    return error.message.slice(0, 2_000);
  }

  return "Unknown outbox publishing error";
};

const isRecord = (
  value: unknown,
): value is Record<string, unknown> => {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
};

const getPayloadId = (
  payload: unknown,
  fieldName: string,
): string => {
  if (
    !isRecord(payload) ||
    typeof payload[fieldName] !== "string" ||
    payload[fieldName].length === 0
  ) {
    throw new Error(
      `Invalid outbox payload: ${fieldName}`,
    );
  }

  return payload[fieldName];
};

const getRetryDelay = (
  attemptCount: number,
): number => {
  const exponent = Math.min(
    Math.max(attemptCount - 1, 0),
    6,
  );

  return Math.min(
    INITIAL_RETRY_DELAY_MS *
      2 ** exponent,
    MAX_RETRY_DELAY_MS,
  );
};

const claimNextMessage =
  async (): Promise<
    ClaimedMessage | null
  > => {
    const now = new Date();

    const candidates = await db
      .select({
        id: outboxMessages.id,
        messageType:
          outboxMessages.messageType,
        payload:
          outboxMessages.payload,
        queueName:
          outboxMessages.queueName,
        attemptCount:
          outboxMessages.attemptCount,
        leaseToken:
          outboxMessages.leaseToken,
      })
      .from(outboxMessages)
      .where(
        or(
          and(
            eq(
              outboxMessages.status,
              "pending",
            ),
            lte(
              outboxMessages.availableAt,
              now,
            ),
          ),
          and(
            eq(
              outboxMessages.status,
              "publishing",
            ),
            or(
              isNull(
                outboxMessages.leaseExpiresAt,
              ),
              lte(
                outboxMessages.leaseExpiresAt,
                now,
              ),
            ),
          ),
        ),
      )
      .orderBy(
        asc(outboxMessages.availableAt),
        asc(outboxMessages.createdAt),
      )
      .limit(CANDIDATE_LIMIT);

    for (const candidate of candidates) {
      const leaseToken = randomUUID();

      const leaseExpiresAt =
        new Date(
          now.getTime() +
            LEASE_DURATION_MS,
        );

      /*
       * Conditional UPDATE is the actual claim.
       *
       * If another publisher claimed this row first,
       * this UPDATE returns no row.
       */
      const [claimed] = await db
        .update(outboxMessages)
        .set({
          status: "publishing",
          attemptCount:
            candidate.attemptCount + 1,
          leaseToken,
          leaseExpiresAt,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(
              outboxMessages.id,
              candidate.id,
            ),
            or(
              and(
                eq(
                  outboxMessages.status,
                  "pending",
                ),
                lte(
                  outboxMessages.availableAt,
                  now,
                ),
              ),
              and(
                eq(
                  outboxMessages.status,
                  "publishing",
                ),
                or(
                  isNull(
                    outboxMessages.leaseExpiresAt,
                  ),
                  lte(
                    outboxMessages.leaseExpiresAt,
                    now,
                  ),
                ),
              ),
            ),
          ),
        )
        .returning({
          id: outboxMessages.id,
          messageType:
            outboxMessages.messageType,
          payload:
            outboxMessages.payload,
          queueName:
            outboxMessages.queueName,
          attemptCount:
            outboxMessages.attemptCount,
          leaseToken:
            outboxMessages.leaseToken,
        });

      if (claimed) {
        return claimed;
      }
    }

    return null;
  };

const publishMessage =
  async (
    message: ClaimedMessage,
  ): Promise<void> => {
    switch (message.queueName) {
      case QUEUE_NAMES.webhook: {
        if (
          message.messageType !==
          JOB_NAMES.githubWebhook
        ) {
          throw new Error(
            "Invalid webhook outbox message type",
          );
        }

        const webhookDeliveryId =
          getPayloadId(
            message.payload,
            "webhookDeliveryId",
          );

        await webhookQueue.add(
          JOB_NAMES.githubWebhook,
          {
            webhookDeliveryId,
          },
          {
          /*
 * Use the outbox row ID as the deterministic BullMQ job ID
 * so duplicate publishes are suppressed while the BullMQ job
 * still exists in Redis.
 */
            jobId: message.id,
          },
        );

        return;
      }

      case QUEUE_NAMES.jobAttempt: {
        if (
          message.messageType !==
          JOB_NAMES.jobAttempt
        ) {
          throw new Error(
            "Invalid job-attempt outbox message type",
          );
        }

        const jobAttemptId =
          getPayloadId(
            message.payload,
            "jobAttemptId",
          );

        await jobAttemptQueue.add(
          JOB_NAMES.jobAttempt,
          {
            jobAttemptId,
          },
          {
            jobId: message.id,
          },
        );

        return;
      }

      case QUEUE_NAMES.deployment: {
        if (
          message.messageType !== JOB_NAMES.deployment
        ) {
          throw new Error(
            "Invalid deployment outbox message type",
          );
        }

        const deploymentId =
          getPayloadId(
            message.payload,
            "deploymentId",
          );

        await deploymentQueue.add(
          JOB_NAMES.deployment,
          {
            deploymentId,
          },
          {
            jobId: message.id,
          },
        );

        return;
      }

      default:
        throw new Error(
          `Unsupported outbox queue: ${message.queueName}`,
        );
    }
  };

const markPublished =
  async (
    messageId: string,
    leaseToken: string,
  ): Promise<void> => {
    await db
      .update(outboxMessages)
      .set({
        status: "published",
        leaseToken: null,
        leaseExpiresAt: null,
        publishedAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
      })
      .where(
        and(
          eq(
            outboxMessages.id,
            messageId,
          ),
          eq(
            outboxMessages.status,
            "publishing",
          ),
          eq(
            outboxMessages.leaseToken,
            leaseToken,
          ),
        ),
      );
  };

const markPublishFailed =
  async (
    messageId: string,
    leaseToken: string,
    attemptCount: number,
    error: unknown,
  ): Promise<void> => {
    const now = new Date();

    const availableAt =
      new Date(
        now.getTime() +
          getRetryDelay(attemptCount),
      );

    await db
      .update(outboxMessages)
      .set({
        status: "pending",
        availableAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError:
          getErrorMessage(error),
        updatedAt: now,
      })
      .where(
        and(
          eq(
            outboxMessages.id,
            messageId,
          ),
          eq(
            outboxMessages.status,
            "publishing",
          ),
          eq(
            outboxMessages.leaseToken,
            leaseToken,
          ),
        ),
      );
  };

export const publishNextOutboxMessage =
  async (): Promise<boolean> => {
    const message =
      await claimNextMessage();

    if (!message) {
      return false;
    }

    if (!message.leaseToken) {
      throw new Error(
        "Claimed outbox message is missing lease token",
      );
    }

    try {
      await publishMessage(message);

      await markPublished(
        message.id,
        message.leaseToken,
      );
    } catch (error) {
      await markPublishFailed(
        message.id,
        message.leaseToken,
        message.attemptCount,
        error,
      );
    }

    return true;
  };
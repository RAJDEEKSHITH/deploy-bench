import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { deadLetters, outboxMessages } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type DeadLetterRow = typeof deadLetters.$inferSelect;

export type DeadLetterStatus = DeadLetterRow["status"];

export type DeadLetterFailureClass = NonNullable<DeadLetterRow["failureClass"]>;

export type DeadLetterDbTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export interface CreateDeadLetterInput {
  sourceType: string;
  sourceId: string;
  queueName: string;
  payload: Record<string, unknown>;
  attempts?: number;
  failureClass?: DeadLetterFailureClass | null;
  errorCode?: string | null;
  errorMessage: string;
  firstFailedAt?: Date;
  lastFailedAt?: Date;
}

export interface ListDeadLettersInput {
  status?: DeadLetterStatus;
  queueName?: string;
  limit?: number;
}

export interface ReplayDeadLetterResult {
  deadLetter: DeadLetterRow;
  outboxMessageId: string;
}

export interface ReplayFailureInput {
  deadLetterId: string;
  failureClass?: DeadLetterFailureClass | null;
  errorCode?: string | null;
  errorMessage: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const MAX_SOURCE_TYPE_LENGTH = 64;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_QUEUE_NAME_LENGTH = 120;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 8_000;

const DEAD_LETTER_REPLAY_MESSAGE_PREFIX = "dead-letter.replay";

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

const requireUuid = (value: string, field: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value.toLowerCase();
};

const normalizeRequiredString = (
  value: string,
  field: string,
  maxLength: number,
): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AppError(`${field} cannot be empty`, 400);
  }

  if (normalized.length > maxLength) {
    throw new AppError(`${field} cannot exceed ${maxLength} characters`, 400);
  }

  return normalized;
};

const normalizeErrorMessage = (value: string): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AppError("Dead-letter error message cannot be empty", 400);
  }

  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

const normalizeErrorCode = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AppError("Dead-letter error code cannot be empty", 400);
  }

  if (normalized.length > MAX_ERROR_CODE_LENGTH) {
    throw new AppError(
      `Dead-letter error code cannot exceed ${MAX_ERROR_CODE_LENGTH} characters`,
      400,
    );
  }

  return normalized;
};

const normalizeAttempts = (attempts: number | undefined): number => {
  const normalized = attempts ?? 0;

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new AppError(
      "Dead-letter attempts must be a non-negative integer",
      400,
    );
  }

  return normalized;
};

const normalizeListLimit = (limit: number | undefined): number => {
  const normalized = limit ?? DEFAULT_LIST_LIMIT;

  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_LIST_LIMIT
  ) {
    throw new AppError(
      `Dead-letter limit must be between 1 and ${MAX_LIST_LIMIT}`,
      400,
    );
  }

  return normalized;
};

/* -------------------------------------------------------------------------- */
/* Stage 41 — Dead letters                                                    */
/* -------------------------------------------------------------------------- */

export const createDeadLetter = async (
  input: CreateDeadLetterInput,
): Promise<DeadLetterRow> => {
  const sourceType = normalizeRequiredString(
    input.sourceType,
    "Dead-letter source type",
    MAX_SOURCE_TYPE_LENGTH,
  );
  const sourceId = normalizeRequiredString(
    input.sourceId,
    "Dead-letter source ID",
    MAX_SOURCE_ID_LENGTH,
  );
  const queueName = normalizeRequiredString(
    input.queueName,
    "Dead-letter queue name",
    MAX_QUEUE_NAME_LENGTH,
  );
  if (
    input.payload === null ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new AppError("Dead-letter payload must be a JSON object", 400);
  }

  const errorMessage = normalizeErrorMessage(input.errorMessage);
  const errorCode = normalizeErrorCode(input.errorCode);
  const attempts = normalizeAttempts(input.attempts);

  const firstFailedAt = input.firstFailedAt ?? new Date();
  const lastFailedAt = input.lastFailedAt ?? firstFailedAt;

  if (Number.isNaN(firstFailedAt.getTime())) {
    throw new AppError("Dead-letter firstFailedAt is invalid", 400);
  }

  if (Number.isNaN(lastFailedAt.getTime())) {
    throw new AppError("Dead-letter lastFailedAt is invalid", 400);
  }

  if (lastFailedAt.getTime() < firstFailedAt.getTime()) {
    throw new AppError(
      "Dead-letter lastFailedAt cannot be earlier than firstFailedAt",
      400,
    );
  }

  const values: typeof deadLetters.$inferInsert = {
    sourceType,
    sourceId,
    queueName,
    payload: input.payload,
    attempts,
    errorMessage,
    status: "open",
    replayCount: 0,
    firstFailedAt,
    lastFailedAt,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: input.failureClass }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };

  const [deadLetter] = await db.insert(deadLetters).values(values).returning();

  if (deadLetter === undefined) {
    throw new AppError("Dead letter could not be created", 500);
  }

  return deadLetter;
};

export const getDeadLetter = async (
  deadLetterId: string,
): Promise<DeadLetterRow> => {
  const id = requireUuid(deadLetterId, "dead-letter ID");

  const [deadLetter] = await db
    .select()
    .from(deadLetters)
    .where(eq(deadLetters.id, id))
    .limit(1);

  if (deadLetter === undefined) {
    throw new AppError("Dead letter not found", 404);
  }

  return deadLetter;
};

export const listDeadLetters = async ({
  status,
  queueName,
  limit,
}: ListDeadLettersInput = {}): Promise<DeadLetterRow[]> => {
  const normalizedLimit = normalizeListLimit(limit);
  const normalizedQueueName =
    queueName === undefined
      ? undefined
      : normalizeRequiredString(
          queueName,
          "Dead-letter queue name",
          MAX_QUEUE_NAME_LENGTH,
        );

  const conditions = [];

  if (status !== undefined) {
    conditions.push(eq(deadLetters.status, status));
  }

  if (normalizedQueueName !== undefined) {
    conditions.push(eq(deadLetters.queueName, normalizedQueueName));
  }

  return db
    .select()
    .from(deadLetters)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deadLetters.createdAt), desc(deadLetters.id))
    .limit(normalizedLimit);
};

/* -------------------------------------------------------------------------- */
/* Stage 42 — Replay                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Replays the same durable payload through the same queue.
 *
 * The dead-letter record itself is reused. A new outbox row represents the
 * transport attempt so the replay remains durable before BullMQ is involved.
 */
export const replayDeadLetter = async (
  deadLetterId: string,
): Promise<ReplayDeadLetterResult> => {
  const id = requireUuid(deadLetterId, "dead-letter ID");

  return db.transaction(async (tx) => {
    const [deadLetter] = await tx
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.id, id))
      .for("update")
      .limit(1);

    if (deadLetter === undefined) {
      throw new AppError("Dead letter not found", 404);
    }

    if (deadLetter.status !== "open") {
      throw new AppError(
        `Dead letter cannot be replayed while it is ${deadLetter.status}`,
        409,
      );
    }

    const nextReplayCount = deadLetter.replayCount + 1;
    if (!Number.isSafeInteger(nextReplayCount)) {
      throw new AppError("Dead-letter replay count overflow", 500);
    }

    const queueName = deadLetter.queueName;

    if (queueName === null) {
      throw new AppError(
        "Dead letter has no queue name and cannot be replayed",
        409,
      );
    }
    const replayedAt = new Date();
    const dedupeKey = `${DEAD_LETTER_REPLAY_MESSAGE_PREFIX}:${deadLetter.id}:${nextReplayCount}`;

    const [outboxMessage] = await tx
      .insert(outboxMessages)
      .values({
        messageType: deadLetter.sourceType,
        aggregateType: deadLetter.sourceType,
        aggregateId: deadLetter.sourceId,
        dedupeKey,
        payload: deadLetter.payload,
        queueName,
        status: "pending",
      })
      .returning({ id: outboxMessages.id });

    if (outboxMessage === undefined) {
      throw new AppError("Dead-letter replay could not be queued", 500);
    }

    const [updatedDeadLetter] = await tx
      .update(deadLetters)
      .set({
        status: "replayed",
        replayCount: nextReplayCount,
        replayedAt,
        resolvedAt: null,
        updatedAt: replayedAt,
      })
      .where(eq(deadLetters.id, deadLetter.id))
      .returning();

    if (updatedDeadLetter === undefined) {
      throw new AppError("Dead-letter replay state could not be updated", 500);
    }

    return {
      deadLetter: updatedDeadLetter,
      outboxMessageId: outboxMessage.id,
    };
  });
};

/**
 * Marks a successfully processed replay as resolved.
 *
 * A replay must already be in the `replayed` state. Repeated resolution of an
 * already resolved record is treated as an idempotent operation.
 */
export const resolveReplayedDeadLetter = async (
  deadLetterId: string,
): Promise<DeadLetterRow> => {
  const id = requireUuid(deadLetterId, "dead-letter ID");

  return db.transaction(async (tx) => {
    const [deadLetter] = await tx
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.id, id))
      .for("update")
      .limit(1);

    if (deadLetter === undefined) {
      throw new AppError("Dead letter not found", 404);
    }

    if (deadLetter.status === "resolved") {
      return deadLetter;
    }

    if (deadLetter.status !== "replayed") {
      throw new AppError(
        `Dead letter cannot be resolved while it is ${deadLetter.status}`,
        409,
      );
    }

    const resolvedAt = new Date();

    const [resolvedDeadLetter] = await tx
      .update(deadLetters)
      .set({
        status: "resolved",
        resolvedAt,
        updatedAt: resolvedAt,
      })
      .where(eq(deadLetters.id, id))
      .returning();

    if (resolvedDeadLetter === undefined) {
      throw new AppError("Dead letter could not be resolved", 500);
    }

    return resolvedDeadLetter;
  });
};

/**
 * Returns a replayed dead letter to `open` after the replayed message fails
 * during normal asynchronous processing.
 *
 * The original first-failure timestamp and replay count are preserved. The
 * latest failure details are recorded in the same dead-letter record.
 */
export const reopenDeadLetterAfterReplayFailure = async ({
  deadLetterId,
  failureClass,
  errorCode,
  errorMessage,
}: ReplayFailureInput): Promise<DeadLetterRow> => {
  const id = requireUuid(deadLetterId, "dead-letter ID");
  const normalizedMessage = normalizeErrorMessage(errorMessage);
  const normalizedCode = normalizeErrorCode(errorCode);

  return db.transaction(async (tx) => {
    const [deadLetter] = await tx
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.id, id))
      .for("update")
      .limit(1);

    if (deadLetter === undefined) {
      throw new AppError("Dead letter not found", 404);
    }

    if (deadLetter.status !== "replayed") {
      throw new AppError(
        `Dead letter cannot be reopened while it is ${deadLetter.status}`,
        409,
      );
    }

    const lastFailedAt = new Date();

    const updateValues: Partial<typeof deadLetters.$inferInsert> = {
      status: "open",
      errorMessage: normalizedMessage,
      lastFailedAt,
      replayedAt: deadLetter.replayedAt,
      resolvedAt: null,
      updatedAt: lastFailedAt,
      ...(failureClass === undefined ? {} : { failureClass }),
      ...(normalizedCode === undefined ? {} : { errorCode: normalizedCode }),
    };

    const [reopenedDeadLetter] = await tx
      .update(deadLetters)
      .set(updateValues)
      .where(eq(deadLetters.id, id))
      .returning();

    if (reopenedDeadLetter === undefined) {
      throw new AppError("Dead letter could not be reopened", 500);
    }

    return reopenedDeadLetter;
  });
};

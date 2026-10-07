import {
  and,
  asc,
  eq,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobs,
  logStreamStatusEnum,
  logStreamTypeEnum,
  logStreams,
  runs,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type LogStreamType =
  (typeof logStreamTypeEnum.enumValues)[number];

export type LogStreamStatus =
  (typeof logStreamStatusEnum.enumValues)[number];

export type LogStream =
  typeof logStreams.$inferSelect;

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_S3_BUCKET_LENGTH = 256;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const normalizeUuid = (
  value: string,
  fieldName: string,
): string => {
  const normalized = value.trim();

  if (!UUID_REGEX.test(normalized)) {
    throw new AppError(
      `${fieldName} must be a valid UUID`,
      400,
    );
  }

  return normalized;
};

const assertStreamType = (
  value: LogStreamType,
): void => {
  if (
    !(
      logStreamTypeEnum.enumValues as readonly string[]
    ).includes(value)
  ) {
    throw new AppError(
      `Invalid log stream type: ${String(value)}`,
      400,
    );
  }
};

const assertStreamStatus = (
  value: LogStreamStatus,
): void => {
  if (
    !(
      logStreamStatusEnum.enumValues as readonly string[]
    ).includes(value)
  ) {
    throw new AppError(
      `Invalid log stream status: ${String(value)}`,
      400,
    );
  }
};

const normalizeS3Bucket = (
  value: string,
): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AppError(
      "S3 bucket cannot be empty",
      500,
    );
  }

  if (
    normalized.length >
    MAX_S3_BUCKET_LENGTH
  ) {
    throw new AppError(
      "S3 bucket name exceeds the database limit",
      500,
    );
  }

  return normalized;
};

/* -------------------------------------------------------------------------- */
/* Job-attempt context                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve:
 *
 * job_attempt
 *      ↓
 * job
 *      ↓
 * run
 *
 * This is the ownership chain that exists in the current schema.
 */
const getJobAttemptContext = async (
  jobAttemptId: string,
): Promise<{
  jobAttemptId: string;
  jobId: string;
  runId: string;
  projectId: string;
}> => {
  const [context] = await db
    .select({
      jobAttemptId: jobAttempts.id,
      jobId: jobs.id,
      runId: runs.id,
      projectId: runs.projectId,
    })
    .from(jobAttempts)
    .innerJoin(
      jobs,
      eq(
        jobAttempts.jobId,
        jobs.id,
      ),
    )
    .innerJoin(
      runs,
      eq(
        jobs.runId,
        runs.id,
      ),
    )
    .where(
      eq(
        jobAttempts.id,
        jobAttemptId,
      ),
    )
    .limit(1);

  if (!context) {
    throw new AppError(
      "Job attempt not found",
      404,
    );
  }

  return context;
};

/* -------------------------------------------------------------------------- */
/* Redis channel                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One live-log channel for one logical job.
 *
 * All attempts of the job publish to the same channel.
 *
 * Example:
 *
 * logs:job:550e8400-e29b-41d4-a716-446655440000
 */
export const getJobLogChannel = (
  jobId: string,
): string => {
  const normalizedJobId =
    normalizeUuid(
      jobId,
      "jobId",
    );

  return `logs:job:${normalizedJobId}`;
};

/* -------------------------------------------------------------------------- */
/* S3 prefix                                                                  */
/* -------------------------------------------------------------------------- */

const buildS3Prefix = ({
  projectId,
  runId,
  jobAttemptId,
  streamType,
}: {
  projectId: string;
  runId: string;
  jobAttemptId: string;
  streamType: LogStreamType;
}): string => {
  return [
    "projects",
    projectId,
    "runs",
    runId,
    "attempts",
    jobAttemptId,
    "logs",
    streamType,
  ].join("/");
};

/* -------------------------------------------------------------------------- */
/* Create or get stream                                                       */
/* -------------------------------------------------------------------------- */

export const getOrCreateLogStream = async ({
  jobAttemptId,
  streamType,
  s3Bucket,
}: {
  jobAttemptId: string;
  streamType: LogStreamType;
  s3Bucket: string;
}): Promise<LogStream> => {
  const normalizedJobAttemptId =
    normalizeUuid(
      jobAttemptId,
      "jobAttemptId",
    );

  const normalizedBucket =
    normalizeS3Bucket(
      s3Bucket,
    );

  assertStreamType(
    streamType,
  );

  const context =
    await getJobAttemptContext(
      normalizedJobAttemptId,
    );

  const s3Prefix =
    buildS3Prefix({
      projectId:
        context.projectId,
      runId:
        context.runId,
      jobAttemptId:
        context.jobAttemptId,
      streamType,
    });

  /**
   * Unique constraint:
   *
   * (jobAttemptId, streamType)
   *
   * means there can be exactly one stdout,
   * one stderr and one system stream per attempt.
   */
  await db
    .insert(logStreams)
    .values({
      jobAttemptId:
        context.jobAttemptId,

      streamType,

      status: "open",

      s3Bucket:
        normalizedBucket,

      s3Prefix,
    })
    .onConflictDoNothing({
      target: [
        logStreams.jobAttemptId,
        logStreams.streamType,
      ],
    });

  const [stream] =
    await db
      .select()
      .from(logStreams)
      .where(
        and(
          eq(
            logStreams.jobAttemptId,
            context.jobAttemptId,
          ),
          eq(
            logStreams.streamType,
            streamType,
          ),
        ),
      )
      .limit(1);

  if (!stream) {
    throw new AppError(
      "Failed to create log stream",
      500,
    );
  }

  /**
   * If two callers race, the first caller creates the row
   * and the second caller receives that existing row.
   *
   * Detect configuration inconsistency rather than silently
   * using the wrong bucket/prefix.
   */
  if (
    stream.s3Bucket !==
      normalizedBucket ||
    stream.s3Prefix !==
      s3Prefix
  ) {
    throw new AppError(
      "Existing log stream has inconsistent storage metadata",
      500,
    );
  }

  return stream;
};

/* -------------------------------------------------------------------------- */
/* Get one stream                                                             */
/* -------------------------------------------------------------------------- */

export const getLogStreamById = async (
  streamId: string,
): Promise<LogStream> => {
  const normalizedStreamId =
    normalizeUuid(
      streamId,
      "streamId",
    );

  const [stream] =
    await db
      .select()
      .from(logStreams)
      .where(
        eq(
          logStreams.id,
          normalizedStreamId,
        ),
      )
      .limit(1);

  if (!stream) {
    throw new AppError(
      "Log stream not found",
      404,
    );
  }

  return stream;
};

/* -------------------------------------------------------------------------- */
/* Get streams for one job attempt                                            */
/* -------------------------------------------------------------------------- */

export const getLogStreamsForJobAttempt =
  async (
    jobAttemptId: string,
  ): Promise<LogStream[]> => {
    const normalizedJobAttemptId =
      normalizeUuid(
        jobAttemptId,
        "jobAttemptId",
      );

    await getJobAttemptContext(
      normalizedJobAttemptId,
    );

    return db
      .select()
      .from(logStreams)
      .where(
        eq(
          logStreams.jobAttemptId,
          normalizedJobAttemptId,
        ),
      )
      .orderBy(
        asc(logStreams.streamType),
      );
  };

/* -------------------------------------------------------------------------- */
/* Close stream                                                               */
/* -------------------------------------------------------------------------- */

export const closeLogStream = async ({
  streamId,
  status,
}: {
  streamId: string;
  status: Extract<
    LogStreamStatus,
    "completed" | "failed"
  >;
}): Promise<LogStream> => {
  const normalizedStreamId =
    normalizeUuid(
      streamId,
      "streamId",
    );

  assertStreamStatus(
    status,
  );

  /**
   * Only an open stream can be transitioned.
   *
   * This makes the operation idempotent.
   */
  const [closed] =
    await db
      .update(logStreams)
      .set({
        status,
        closedAt:
          new Date(),
      })
      .where(
        and(
          eq(
            logStreams.id,
            normalizedStreamId,
          ),
          eq(
            logStreams.status,
            "open",
          ),
        ),
      )
      .returning();

  if (closed) {
    return closed;
  }

  /**
   * Already closed.
   *
   * Do not overwrite its original terminal state.
   */
  return getLogStreamById(
    normalizedStreamId,
  );
};
import {
  createHash,
} from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  and,
  eq,
} from "drizzle-orm";

import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import {
  jobAttempts,
  logChunks,
  logStreams,
} from "../../db/schema.js";
import {
  redisConnection,
} from "../../lib/redis/redis.client.js";
import {
  getJobLogChannel,
} from "./log-stream.service.js";
import { AppError } from "../../utils/app.error.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type AppendLogChunkInput = {
  streamId: string;
  data:
    | Buffer
    | Uint8Array
    | string;

  firstTimestamp?:
    | Date
    | null;

  lastTimestamp?:
    | Date
    | null;
};

export type AppendLogChunkResult = {
  chunkId: number;
  streamId: string;
  jobAttemptId: string;
  sequence: number;
  s3Bucket: string;
  s3Key: string;
  sizeInBytes: number;
  lineCount: number;
  sha256: string;

  /**
   * true:
   * Redis accepted the live event.
   *
   * false:
   * durable PostgreSQL/S3 persistence succeeded,
   * but live Redis delivery was unavailable.
   */
  livePublished: boolean;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const POSTGRES_INT_MAX =
  2_147_483_647;

const SEQUENCE_WIDTH = 6;

/* -------------------------------------------------------------------------- */
/* S3 client                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One S3 client for the process.
 *
 * Do NOT create one S3Client for every log chunk.
 *
 * AWS SDK resolves region/credentials through its normal provider chain.
 */
const s3Client =
  new S3Client({ region: env.S3_REGION });

/**
 * Call once during application shutdown.
 */
export const closeLogStorage =
  (): void => {
    s3Client.destroy();
  };


/**
 * Read one durable log chunk from S3.
 * The database stores chunk metadata; the object body remains in S3.
 */
export const readLogChunk = async ({
  bucket,
  key,
}: {
  bucket: string;
  key: string;
}): Promise<string> => {
  const normalizedBucket = bucket.trim();
  const normalizedKey = key.trim();

  if (!normalizedBucket || !normalizedKey) {
    throw new AppError("Log chunk storage metadata is invalid", 500);
  }

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: normalizedBucket,
      Key: normalizedKey,
    }),
  );

  if (!response.Body) {
    throw new AppError("S3 log chunk response was empty", 502);
  }

  return response.Body.transformToString("utf-8");
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const normalizeUuid = (
  value: string,
  fieldName: string,
): string => {
  const normalized =
    value.trim();

  if (
    !UUID_REGEX.test(
      normalized,
    )
  ) {
    throw new AppError(
      `${fieldName} must be a valid UUID`,
      400,
    );
  }

  return normalized;
};

const normalizeData = (
  data:
    | Buffer
    | Uint8Array
    | string,
): Buffer => {
  if (
    Buffer.isBuffer(data)
  ) {
    return data;
  }

  if (
    data instanceof Uint8Array
  ) {
    return Buffer.from(data);
  }

  if (
    typeof data ===
    "string"
  ) {
    return Buffer.from(
      data,
      "utf8",
    );
  }

  throw new AppError(
    "Log chunk data must be a Buffer, Uint8Array, or string",
    400,
  );
};

const assertTimestamp = (
  value:
    | Date
    | null
    | undefined,
  fieldName: string,
): void => {
  if (
    value === undefined ||
    value === null
  ) {
    return;
  }

  if (
    !(value instanceof Date)
  ) {
    throw new AppError(
      `${fieldName} must be a Date`,
      400,
    );
  }

  if (
    Number.isNaN(
      value.getTime(),
    )
  ) {
    throw new AppError(
      `${fieldName} is invalid`,
      400,
    );
  }
};

/* -------------------------------------------------------------------------- */
/* Line counting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Count newline delimiters rather than independently counting
 * "lines" in each chunk.
 *
 * This is important because one logical line can be split across
 * two chunks:
 *
 * chunk 1: "hello wor"
 * chunk 2: "ld\n"
 *
 * Counting newline delimiters avoids counting that as two lines.
 *
 * Therefore lineCount represents the number of newline delimiters
 * contained in the chunk.
 */
const countNewlineDelimiters = (
  data: Buffer,
): number => {
  let count = 0;

  for (
    let index = 0;
    index < data.length;
    index += 1
  ) {
    if (
      data[index] ===
      0x0a
    ) {
      count += 1;
    }
  }

  return count;
};

/* -------------------------------------------------------------------------- */
/* S3 key                                                                     */
/* -------------------------------------------------------------------------- */

const buildS3Key = ({
  prefix,
  sequence,
}: {
  prefix: string;
  sequence: number;
}): string => {
  const cleanPrefix =
    prefix.replace(
      /\/+$/,
      "",
    );

  const sequenceName =
    String(sequence).padStart(
      SEQUENCE_WIDTH,
      "0",
    );

  return `${cleanPrefix}/${sequenceName}.log`;
};

/* -------------------------------------------------------------------------- */
/* Redis publication                                                          */
/* -------------------------------------------------------------------------- */

const publishLiveLog = async ({
  jobId,
  jobAttemptId,
  streamId,
  streamType,
  sequence,
  data,
}: {
  jobId: string;
  jobAttemptId: string;
  streamId: string;
  streamType:
    | "stdout"
    | "stderr"
    | "system";
  sequence: number;
  data: Buffer;
}): Promise<boolean> => {
  /**
   * Don't queue live messages locally while Redis
   * is unavailable.
   *
   * S3 + PostgreSQL are the durable source.
   */
  if (
    redisConnection.status !==
    "ready"
  ) {
    return false;
  }

  const channel =
    getJobLogChannel(
      jobId,
    );

  const payload =
    JSON.stringify({
      jobAttemptId,
      streamId,
      streamType,
      sequence,
      data:
        data.toString(
          "utf8",
        ),
    });

  try {
    /**
     * Publish only AFTER the DB transaction has committed.
     */
    await redisConnection.publish(
      channel,
      payload,
    );

    return true;
  } catch (error: unknown) {
    /**
     * Live delivery is best-effort.
     *
     * Do not destroy the durable log just because Redis
     * is temporarily unavailable.
     */
    console.error(
      "Failed to publish live log",
      {
        jobId,
        jobAttemptId,
        streamId,
        sequence,
        error,
      },
    );

    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* Append chunk                                                               */
/* -------------------------------------------------------------------------- */

export const appendLogChunk = async ({
  streamId,
  data,
  firstTimestamp = null,
  lastTimestamp = null,
}: AppendLogChunkInput): Promise<AppendLogChunkResult> => {
  const normalizedStreamId =
    normalizeUuid(
      streamId,
      "streamId",
    );

  const buffer =
    normalizeData(data);

  /**
   * Empty chunks do not contain a log record,
   * so don't create pointless S3/DB objects.
   */
  if (
    buffer.length === 0
  ) {
    throw new AppError(
      "Cannot append an empty log chunk",
      400,
    );
  }

  if (
    buffer.length >
    POSTGRES_INT_MAX
  ) {
    throw new AppError(
      "Log chunk exceeds PostgreSQL integer size",
      413,
    );
  }

  assertTimestamp(
    firstTimestamp,
    "firstTimestamp",
  );

  assertTimestamp(
    lastTimestamp,
    "lastTimestamp",
  );

  if (
    firstTimestamp !==
      null &&
    firstTimestamp !==
      undefined &&
    lastTimestamp !==
      null &&
    lastTimestamp !==
      undefined &&
    firstTimestamp.getTime() >
      lastTimestamp.getTime()
  ) {
    throw new AppError(
      "firstTimestamp cannot be after lastTimestamp",
      400,
    );
  }

  const lineCount =
    countNewlineDelimiters(
      buffer,
    );

  const sha256 =
    createHash("sha256")
      .update(buffer)
      .digest("hex");

  /**
   * Used only if S3 succeeded but the DB transaction later fails.
   */
type UploadedObject = {
  bucket: string;
  key: string;
};

let uploadedObject:
  | UploadedObject
  | undefined;  

  try {
    const persisted =
      await db.transaction(
        async (tx) => {
          /**
           * IMPORTANT:
           *
           * The stream row is locked so concurrent Docker output
           * calls cannot receive the same sequence.
           *
           * lastSequence:
           *
           * -1 → first chunk gets 0
           *  0 → next chunk gets 1
           *  1 → next chunk gets 2
           */
          const [stream] =
            await tx
              .select({
                id:
                  logStreams.id,
                jobAttemptId:
                  logStreams.jobAttemptId,
                streamType:
                  logStreams.streamType,
                status:
                  logStreams.status,
                s3Bucket:
                  logStreams.s3Bucket,
                s3Prefix:
                  logStreams.s3Prefix,
                totalBytes:
                  logStreams.totalBytes,
                totalLines:
                  logStreams.totalLines,
                lastSequence:
                  logStreams.lastSequence,
                closedAt:
                  logStreams.closedAt,
              })
              .from(logStreams)
              .where(
                eq(
                  logStreams.id,
                  normalizedStreamId,
                ),
              )
              .for("update")
              .limit(1);

          if (!stream) {
            throw new AppError(
              "Log stream not found",
              404,
            );
          }

          if (
            stream.status !==
            "open"
          ) {
            throw new AppError(
              "Log stream is not open",
              409,
            );
          }

          if (
            stream.closedAt !==
            null
          ) {
            throw new AppError(
              "Log stream is already closed",
              409,
            );
          }

          /**
           * job_attempts exists directly in the current schema.
           */
          const [attempt] =
            await tx
              .select({
                id:
                  jobAttempts.id,
                jobId:
                  jobAttempts.jobId,
              })
              .from(jobAttempts)
              .where(
                eq(
                  jobAttempts.id,
                  stream.jobAttemptId,
                ),
              )
              .limit(1);

          if (!attempt) {
            throw new AppError(
              "Owning job attempt not found",
              500,
            );
          }

          const previousSequence =
            stream.lastSequence;

          if (
            !Number.isSafeInteger(
              previousSequence,
            )
          ) {
            throw new AppError(
              "Invalid log stream sequence",
              500,
            );
          }

          const sequence =
            previousSequence +
            1;

          if (
            !Number.isSafeInteger(
              sequence,
            ) ||
            sequence < 0 ||
            sequence >
              POSTGRES_INT_MAX
          ) {
            throw new AppError(
              "Log stream sequence limit reached",
              500,
            );
          }

          if (
            !Number.isSafeInteger(
              stream.totalBytes,
            ) ||
            !Number.isSafeInteger(
              stream.totalLines,
            )
          ) {
            throw new AppError(
              "Log stream counters are outside the safe integer range",
              500,
            );
          }

          const nextTotalBytes =
            stream.totalBytes +
            buffer.length;

          const nextTotalLines =
            stream.totalLines +
            lineCount;

          if (
            !Number.isSafeInteger(
              nextTotalBytes,
            )
          ) {
            throw new AppError(
              "Log stream byte counter overflow",
              500,
            );
          }

          if (
            !Number.isSafeInteger(
              nextTotalLines,
            )
          ) {
            throw new AppError(
              "Log stream line counter overflow",
              500,
            );
          }

          const s3Key =
            buildS3Key({
              prefix:
                stream.s3Prefix,
              sequence,
            });

          /**
           * External side effect.
           *
           * It happens while the stream row is locked so the
           * sequence remains authoritative.
           */
          await s3Client.send(
            new PutObjectCommand({
              Bucket:
                stream.s3Bucket,
              Key:
                s3Key,
              Body:
                buffer,
              ContentType:
                "text/plain; charset=utf-8",
            }),
          );

          uploadedObject = {
            bucket:
              stream.s3Bucket,
            key:
              s3Key,
          };

          /**
           * PostgreSQL metadata is persisted only after
           * S3 accepted the object.
           */
          const [chunk] =
            await tx
              .insert(logChunks)
              .values({
                logStreamId:
                  stream.id,

                sizeInBytes:
                  buffer.length,

                s3Key,

                sequence,

                lineCount,

                sha256,

                firstTimestamp:
                  firstTimestamp ??
                  null,

                lastTimestamp:
                  lastTimestamp ??
                  null,
              })
              .returning({
                id:
                  logChunks.id,
              });

          if (!chunk) {
            throw new AppError(
              "Failed to persist log chunk",
              500,
            );
          }

          const [updatedStream] =
            await tx
              .update(logStreams)
              .set({
                totalBytes:
                  nextTotalBytes,

                totalLines:
                  nextTotalLines,

                lastSequence:
                  sequence,
              })
              .where(
                eq(
                  logStreams.id,
                  stream.id,
                ),
              )
              .returning({
                id:
                  logStreams.id,
              });

          if (!updatedStream) {
            throw new AppError(
              "Failed to update log stream",
              500,
            );
          }

          return {
            chunkId:
              chunk.id,

            jobId:
              attempt.jobId,

            jobAttemptId:
              stream.jobAttemptId,

            streamId:
              stream.id,

            streamType:
              stream.streamType,

            sequence,

            s3Bucket:
              stream.s3Bucket,

            s3Key,

            sizeInBytes:
              buffer.length,

            lineCount,

            sha256,
          };
        },
      );

    /**
     * VERY IMPORTANT:
     *
     * Publish only after PostgreSQL has committed.
     *
     * Otherwise SSE could receive an event for a transaction
     * that subsequently rolled back.
     */
    const livePublished =
      await publishLiveLog({
        jobId:
          persisted.jobId,

        jobAttemptId:
          persisted.jobAttemptId,

        streamId:
          persisted.streamId,

        streamType:
          persisted.streamType,

        sequence:
          persisted.sequence,

        data:
          buffer,
      });

    return {
      chunkId:
        persisted.chunkId,

      streamId:
        persisted.streamId,

      jobAttemptId:
        persisted.jobAttemptId,

      sequence:
        persisted.sequence,

      s3Bucket:
        persisted.s3Bucket,

      s3Key:
        persisted.s3Key,

      sizeInBytes:
        persisted.sizeInBytes,

      lineCount:
        persisted.lineCount,

      sha256:
        persisted.sha256,

      livePublished,
    };
  } catch (error: unknown) {
 /**
   * DB failed after S3 succeeded.
   *
   * Best-effort cleanup prevents an orphaned S3 object.
   */
  const objectToDelete =
    uploadedObject;

  if (objectToDelete) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket:
            objectToDelete.bucket,
          Key:
            objectToDelete.key,
        }),
      );
    } catch (
      cleanupError: unknown
    ) {
      console.error(
        "Failed to clean up orphaned S3 log object",
        {
          bucket:
            objectToDelete.bucket,
          key:
            objectToDelete.key,
          cleanupError,
        },
      );
    }
  }

  throw error;
  }
};



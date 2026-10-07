import type { Response } from "express";
import type { Redis } from "ioredis";

import {
  and,
  eq,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobs,
  logStreamTypeEnum,
  runs,
} from "../../db/schema.js";
import {
  createRedisSubscriber,
} from "../../lib/redis/redis.client.js";
import {
  getJobLogChannel,
} from "./log-stream.service.js";
import { AppError } from "../../utils/app.error.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type LogStreamType =
  (typeof logStreamTypeEnum.enumValues)[number];

type LiveLogMessage = {
  jobAttemptId: string;
  streamId: string;
  streamType: LogStreamType;
  sequence: number;
  data: string;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HEARTBEAT_INTERVAL_MS =
  15_000;

const MAX_PENDING_BYTES =
  8 * 1024 * 1024;

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

const isStreamType = (
  value: unknown,
): value is LogStreamType => {
  return (
    typeof value ===
      "string" &&
    (
      logStreamTypeEnum.enumValues as readonly string[]
    ).includes(value)
  );
};

/* -------------------------------------------------------------------------- */
/* Redis payload validation                                                   */
/* -------------------------------------------------------------------------- */

const isLiveLogMessage = (
  value: unknown,
): value is LiveLogMessage => {
  if (
    typeof value !==
      "object" ||
    value === null
  ) {
    return false;
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  return (
    typeof record.jobAttemptId ===
      "string" &&
    UUID_REGEX.test(
      record.jobAttemptId,
    ) &&

    typeof record.streamId ===
      "string" &&
    UUID_REGEX.test(
      record.streamId,
    ) &&

    isStreamType(
      record.streamType,
    ) &&

    typeof record.sequence ===
      "number" &&
    Number.isSafeInteger(
      record.sequence,
    ) &&
    record.sequence >= 0 &&

    typeof record.data ===
      "string"
  );
};

/* -------------------------------------------------------------------------- */
/* Verify job belongs to run                                                  */
/* -------------------------------------------------------------------------- */

const assertJobBelongsToRun =
  async ({
    runId,
    jobId,
  }: {
    runId: string;
    jobId: string;
  }): Promise<void> => {
    const [result] =
      await db
        .select({
          jobId:
            jobs.id,
          runId:
            runs.id,
        })
        .from(jobs)
        .innerJoin(
          runs,
          eq(
            jobs.runId,
            runs.id,
          ),
        )
        .where(
          and(
            eq(
              jobs.id,
              jobId,
            ),
            eq(
              runs.id,
              runId,
            ),
          ),
        )
        .limit(1);

    if (!result) {
      throw new AppError(
        "Job not found in the specified run",
        404,
      );
    }
  };

/* -------------------------------------------------------------------------- */
/* SSE serialization                                                          */
/* -------------------------------------------------------------------------- */

const formatSseEvent = ({
  event,
  data,
}: {
  event: string;
  data: unknown;
}): string => {
  return (
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`
  );
};

/* -------------------------------------------------------------------------- */
/* Stream job logs                                                            */
/* -------------------------------------------------------------------------- */

export const streamJobLogs =
  async ({
    response,
    runId,
    jobId,
  }: {
    response: Response;
    runId: string;
    jobId: string;
  }): Promise<void> => {
    const normalizedRunId =
      normalizeUuid(
        runId,
        "runId",
      );

    const normalizedJobId =
      normalizeUuid(
        jobId,
        "jobId",
      );

    /**
     * HTTP-level resource authorization is expected to happen
     * through the authentication middleware before reaching this
     * service.
     *
     * This service additionally verifies the requested job belongs
     * to the requested run.
     */
    await assertJobBelongsToRun({
      runId:
        normalizedRunId,
      jobId:
        normalizedJobId,
    });

    const channel =
      getJobLogChannel(
        normalizedJobId,
      );

    /**
     * THIS CONNECTION BELONGS TO THIS SSE REQUEST.
     *
     * It must be closed when the request terminates.
     */
    const subscriber:
      Redis =
        createRedisSubscriber();

    let closed = false;

    let cleanupPromise:
      | Promise<void>
      | null = null;

    let pendingBytes = 0;

    const pendingEvents:
      string[] = [];

    let writeBlocked =
      false;

    /* ---------------------------------------------------------------------- */
    /* Cleanup                                                                */
    /* ---------------------------------------------------------------------- */

    const cleanup =
      (): Promise<void> => {
        if (
          cleanupPromise !==
          null
        ) {
          return cleanupPromise;
        }

        closed = true;

        cleanupPromise =
          (async (): Promise<void> => {
            clearInterval(
              heartbeatTimer,
            );

            /**
             * Remove listeners before disconnecting.
             *
             * This prevents cleanup-generated Redis events from
             * continuing to invoke application logic.
             */
            subscriber.removeListener(
              "message",
              onMessage,
            );

            subscriber.removeListener(
              "error",
              onRedisError,
            );

            response.removeListener(
              "drain",
              flushPending,
            );

            /**
             * This is a request-owned connection.
             *
             * Close it regardless of why the SSE request ended.
             */
            try {
              if (
                subscriber.status !==
                "end"
              ) {
                subscriber.disconnect();
              }
            } catch {
              /**
               * Cleanup itself must never throw.
               */
            }
          })();

        return cleanupPromise;
      };

    /* ---------------------------------------------------------------------- */
    /* Flush pending SSE data                                                 */
    /* ---------------------------------------------------------------------- */

   const flushPending = (): void => {
  if (
    closed ||
    response.writableEnded ||
    response.destroyed
  ) {
    void cleanup();
    return;
  }

  writeBlocked = false;

  while (pendingEvents.length > 0) {
    const event = pendingEvents[0];

    /**
     * Required because noUncheckedIndexedAccess makes
     * array indexing return T | undefined.
     */
    if (event === undefined) {
      break;
    }

    let writable = true;

    try {
      writable = response.write(event);
    } catch {
      void cleanup();
      return;
    }

    /**
     * The event has now been handed to the response stream,
     * so it can be removed from our pending queue.
     */
    pendingEvents.shift();

    pendingBytes -= Buffer.byteLength(
      event,
      "utf8",
    );

    if (!writable) {
      writeBlocked = true;
      return;
    }
  }
};

    /* ---------------------------------------------------------------------- */
    /* Send SSE event                                                         */
    /* ---------------------------------------------------------------------- */

    const sendEvent = ({
      event,
      data,
    }: {
      event: string;
      data: unknown;
    }): void => {
      if (
        closed ||
        response.writableEnded ||
        response.destroyed
      ) {
        void cleanup();
        return;
      }

      const serialized =
        formatSseEvent({
          event,
          data,
        });

      const eventBytes =
        Buffer.byteLength(
          serialized,
          "utf8",
        );

      /**
       * The browser/network is slower than the producer.
       */
      if (
        writeBlocked ||
        pendingEvents.length >
          0
      ) {
        if (
          pendingBytes +
            eventBytes >
          MAX_PENDING_BYTES
        ) {
          try {
            response.write(
              formatSseEvent({
                event:
                  "error",
                data: {
                  code:
                    "SSE_CLIENT_TOO_SLOW",
                  message:
                    "The log client could not keep up with the live stream.",
                },
              }),
            );
          } catch {
            // Ignore write failure during cleanup.
          }

          void cleanup();
          return;
        }

        pendingEvents.push(
          serialized,
        );

        pendingBytes +=
          eventBytes;

        return;
      }

      try {
        const writable =
          response.write(
            serialized,
          );

        if (!writable) {
          writeBlocked =
            true;
        }
      } catch {
        void cleanup();
      }
    };

    /* ---------------------------------------------------------------------- */
    /* Redis message handler                                                  */
    /* ---------------------------------------------------------------------- */

    const onMessage = (
      receivedChannel: string,
      message: string,
    ): void => {
      if (
        closed ||
        receivedChannel !==
          channel
      ) {
        return;
      }

      let parsed: unknown;

      try {
        parsed =
          JSON.parse(
            message,
          );
      } catch {
        sendEvent({
          event: "error",
          data: {
            code:
              "INVALID_LOG_MESSAGE",
            message:
              "Received malformed log data.",
          },
        });

        void cleanup();
        return;
      }

      if (
        !isLiveLogMessage(
          parsed,
        )
      ) {
        sendEvent({
          event: "error",
          data: {
            code:
              "INVALID_LOG_MESSAGE",
            message:
              "Received invalid log data.",
          },
        });

        void cleanup();
        return;
      }

      sendEvent({
        event: "log",
        data: parsed,
      });
    };

    /* ---------------------------------------------------------------------- */
    /* Redis error handler                                                    */
    /* ---------------------------------------------------------------------- */

    const onRedisError = (
      error: Error,
    ): void => {
      if (closed) {
        return;
      }

      console.error(
        "Redis SSE subscriber error",
        {
          runId:
            normalizedRunId,
          jobId:
            normalizedJobId,
          error,
        },
      );

      sendEvent({
        event:
          "error",
        data: {
          code:
            "REDIS_CONNECTION_ERROR",
          message:
            "Live log connection was interrupted.",
        },
      });

      void cleanup();
    };

    /* ---------------------------------------------------------------------- */
    /* Heartbeat                                                              */
    /* ---------------------------------------------------------------------- */

    const heartbeatTimer =
      setInterval(() => {
        if (
          closed ||
          response.writableEnded ||
          response.destroyed
        ) {
          void cleanup();
          return;
        }

        /**
         * Don't add heartbeat traffic behind a blocked
         * write buffer.
         */
        if (
          writeBlocked ||
          pendingEvents.length >
            0
        ) {
          return;
        }

        try {
          const writable =
            response.write(
              ": heartbeat\n\n",
            );

          if (!writable) {
            writeBlocked =
              true;
          }
        } catch {
          void cleanup();
        }
      }, HEARTBEAT_INTERVAL_MS);

    /* ---------------------------------------------------------------------- */
    /* Event listeners                                                        */
    /* ---------------------------------------------------------------------- */

    subscriber.on(
      "message",
      onMessage,
    );

    subscriber.on(
      "error",
      onRedisError,
    );

    /**
     * Browser closed connection / network disconnected.
     */
    response.once(
      "close",
      () => {
        void cleanup();
      },
    );

    response.on(
      "drain",
      flushPending,
    );

    /* ---------------------------------------------------------------------- */
    /* SSE headers                                                            */
    /* ---------------------------------------------------------------------- */

    response.status(200);

    response.setHeader(
      "Content-Type",
      "text/event-stream",
    );

    response.setHeader(
      "Cache-Control",
      "no-cache, no-transform",
    );

    response.setHeader(
      "Connection",
      "keep-alive",
    );

    /**
     * Prevent nginx from buffering the SSE stream.
     */
    response.setHeader(
      "X-Accel-Buffering",
      "no",
    );

    try {
      response.flushHeaders();
    } catch {
      await cleanup();
      return;
    }

    /* ---------------------------------------------------------------------- */
    /* Subscribe                                                              */
    /* ---------------------------------------------------------------------- */

    try {
      await subscriber.subscribe(
        channel,
      );

      /**
       * The client could have disconnected while Redis was
       * performing the SUBSCRIBE command.
       */
      if (
        closed ||
        response.writableEnded ||
        response.destroyed
      ) {
        return;
      }

      sendEvent({
        event:
          "ready",
        data: {
          runId:
            normalizedRunId,
          jobId:
            normalizedJobId,
        },
      });
    } catch (error: unknown) {
      console.error(
        "Failed to subscribe to live logs",
        {
          runId:
            normalizedRunId,
          jobId:
            normalizedJobId,
          error,
        },
      );

      if (
        !closed &&
        !response.writableEnded &&
        !response.destroyed
      ) {
        sendEvent({
          event:
            "error",
          data: {
            code:
              "LOG_STREAM_UNAVAILABLE",
            message:
              "Unable to subscribe to live logs.",
          },
        });
      }

      await cleanup();
    }
  };
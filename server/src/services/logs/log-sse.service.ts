import type { Response } from "express";
import { and, asc, eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobs,
  logChunks,
  logStreams,
  runs,
} from "../../db/schema.js";
import { createRedisSubscriber } from "../../lib/redis/redis.client.js";
import { readLogChunk } from "./log-chunk.service.js";
import { getJobLogChannel } from "./log-stream.service.js";

type LiveLogPayload = {
  jobAttemptId?: string;
  streamId?: string;
  streamType?: "stdout" | "stderr" | "system";
  sequence?: number;
  data?: string;
  timestamp?: string;
};

type HistoryChunk = {
  jobAttemptId: string;
  attemptNumber: number;
  streamId: string;
  streamType: "stdout" | "stderr" | "system";
  sequence: number;
  s3Bucket: string;
  s3Key: string;
  timestamp: Date | null;
  createdAt: Date;
};

const isTerminalJobStatus = (status: string): boolean =>
  ["success", "failed", "cancelled", "skipped"].includes(status);

export const streamJobLogs = async ({
  response,
  runId,
  jobId,
}: {
  response: Response;
  runId: string;
  jobId: string;
}): Promise<void> => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();

  const writeEvent = (eventName: string, payload: unknown): void => {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  writeEvent("system", {
    streamType: "system",
    text: "Connecting to the job log stream...",
  });

  const subscriber = createRedisSubscriber();
  const channel = getJobLogChannel(jobId);
  const seenChunks = new Set<string>();
  const pendingMessages: string[] = [];
  let historyLoaded = false;
  let cleanedUp = false;

  const sendLiveMessage = (rawMessage: string): void => {
    let payload: LiveLogPayload;
    try {
      payload = JSON.parse(rawMessage) as LiveLogPayload;
    } catch {
      writeEvent("log", {
        streamType: "system",
        data: rawMessage,
      });
      return;
    }

    if (
      typeof payload.streamId === "string" &&
      typeof payload.sequence === "number"
    ) {
      const key = `${payload.streamId}:${payload.sequence}`;
      if (seenChunks.has(key)) return;
      seenChunks.add(key);
    }

    writeEvent("log", payload);
  };

  const onMessage = (receivedChannel: string, message: string): void => {
    if (receivedChannel !== channel) return;
    if (!historyLoaded) {
      pendingMessages.push(message);
      return;
    }
    sendLiveMessage(message);
  };

  subscriber.on("message", onMessage);
  subscriber.on("error", (error: unknown) => {
    console.error("Redis log subscriber error", { jobId, error });
  });

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(": keep-alive\n\n");
    }
  }, 20_000);

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    subscriber.removeListener("message", onMessage);
    void (async () => {
      try {
        await subscriber.unsubscribe(channel);
      } catch {
        // The connection may already be closed.
      }
      try {
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    })();
  };

  response.once("close", cleanup);

  let subscriptionFailed = false;
  try {
    // Subscribe first, so new chunks cannot fall into the history/live gap.
    await subscriber.subscribe(channel);
    writeEvent("system", {
      streamType: "system",
      text: "Connected. Loading saved logs and waiting for live output...",
    });
  } catch (error: unknown) {
    // A Redis outage must not hide logs already persisted in S3/PostgreSQL.
    subscriptionFailed = true;
    console.error("Failed to subscribe to the job log channel", { jobId, error });
    writeEvent("stream-error", {
      message: "Live log delivery is unavailable. Loading saved logs instead.",
    });
  }

  try {
    const historyRows = await db
      .select({
        jobAttemptId: jobAttempts.id,
        attemptNumber: jobAttempts.attemptNumber,
        streamId: logStreams.id,
        streamType: logStreams.streamType,
        sequence: logChunks.sequence,
        s3Bucket: logStreams.s3Bucket,
        s3Key: logChunks.s3Key,
        timestamp: logChunks.lastTimestamp,
        createdAt: logChunks.createdAt,
      })
      .from(logChunks)
      .innerJoin(logStreams, eq(logChunks.logStreamId, logStreams.id))
      .innerJoin(jobAttempts, eq(logStreams.jobAttemptId, jobAttempts.id))
      .innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
      .innerJoin(runs, eq(jobs.runId, runs.id))
      .where(and(eq(jobs.id, jobId), eq(runs.id, runId)))
      .orderBy(
        asc(jobAttempts.attemptNumber),
        asc(logChunks.createdAt),
        asc(logChunks.id),
      ) as HistoryChunk[];

    for (const chunk of historyRows) {
      if (response.destroyed || response.writableEnded) return;

      try {
        const data = await readLogChunk({
          bucket: chunk.s3Bucket,
          key: chunk.s3Key,
        });

        seenChunks.add(`${chunk.streamId}:${chunk.sequence}`);
        writeEvent("history", {
          jobAttemptId: chunk.jobAttemptId,
          attemptNumber: chunk.attemptNumber,
          streamId: chunk.streamId,
          streamType: chunk.streamType,
          sequence: chunk.sequence,
          timestamp: (chunk.timestamp ?? chunk.createdAt).toISOString(),
          data,
        });
      } catch (error: unknown) {
        console.error("Failed to read a persisted job log chunk", {
          jobId,
          streamId: chunk.streamId,
          sequence: chunk.sequence,
          error,
        });
        writeEvent("stream-error", {
          message: `Could not load saved log chunk ${chunk.sequence}. Live output will continue.`,
        });
      }
    }
  } catch (error: unknown) {
    console.error("Failed to load persisted job logs", { runId, jobId, error });
    writeEvent("stream-error", {
      message: "Could not load saved logs. Live output will continue.",
    });
  }

  // Drain events received while history was being read. Chunk IDs suppress
  // duplicates that were included in both the history query and Redis buffer.
  historyLoaded = true;
  for (const message of pendingMessages.splice(0)) {
    if (response.destroyed || response.writableEnded) return;
    sendLiveMessage(message);
  }

  if (response.destroyed || response.writableEnded) return;

  try {
    const [job] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .innerJoin(runs, eq(jobs.runId, runs.id))
      .where(and(eq(jobs.id, jobId), eq(runs.id, runId)))
      .limit(1);

    if (subscriptionFailed || (job && isTerminalJobStatus(job.status))) {
      writeEvent("end", {
        message: subscriptionFailed
          ? "Saved logs were loaded, but live delivery is unavailable."
          : "Job log stream is complete.",
      });
      response.end();
    }
  } catch (error: unknown) {
    console.error("Failed to resolve job log stream status", { runId, jobId, error });
    writeEvent("stream-error", { message: "Saved logs were loaded, but the stream status could not be checked." });
    writeEvent("end", {});
    response.end();
  }
};

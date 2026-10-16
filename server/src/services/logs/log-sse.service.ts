import type { Response } from "express";
import { createRedisSubscriber } from "../../lib/redis/redis.client.js";

export const streamJobLogs = async ({
  response,
  runId,
  jobId,
}: {
  response: Response;
  runId: string;
  jobId: string;
}) => {
  // 1. Establish Server-Sent Events (SSE) headers
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  response.write(`data: {"streamType":"system","text":"Connecting to live log stream..."}\n\n`);

  const subscriber = createRedisSubscriber();
  const channel = `logs:${runId}:${jobId}`;

  try {
    // 2. Subscribe to the specific job's Redis channel
    await subscriber.subscribe(channel);
    response.write(`data: {"streamType":"system","text":"Connected. Waiting for logs..."}\n\n`);
  } catch (err) {
    console.error(`[SSE] Failed to subscribe to logs for job ${jobId}:`, err);
    response.write(`data: {"streamType":"stderr","text":"Backend error: Failed to connect to Redis stream."}\n\n`);
    response.end();
    return;
  }

  // 3. Listen for published messages from the job-attempt worker
  subscriber.on("message", (ch, message) => {
    if (ch === channel) {
      response.write(`data: ${message}\n\n`);
    }
  });

  // 4. Clean up the Redis connection if the user closes the browser tab
  response.on("close", () => {
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.quit().catch(() => {});
  });
};
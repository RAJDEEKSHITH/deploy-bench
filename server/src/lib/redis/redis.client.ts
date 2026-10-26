import { Redis } from "ioredis";
import { env } from "../../config/env.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
});

export const workerRedisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const createRedisSubscriber = (): Redis => {
  // Override: Allow offline queueing so subscribe() doesn't crash while connecting
  return redisConnection.duplicate({ enableOfflineQueue: true });
};

const closeRedisConnection = async (connection: Redis): Promise<void> => {
  if (connection.status === "end") return;
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
};

export const closeRedisConnections = async (): Promise<void> => {
  await Promise.allSettled([
    closeRedisConnection(redisConnection),
    closeRedisConnection(workerRedisConnection),
  ]);
};
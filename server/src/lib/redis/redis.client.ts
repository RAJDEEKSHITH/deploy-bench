import { Redis } from "ioredis";
import { env } from "../../config/env.js";

/**
 * Shared Redis connection used by normal application commands
 * such as publish/get/set/etc.
 */
export const redisConnection = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
});

/**
 * Shared Redis connection for long-lived worker usage.
 *
 * BullMQ workers require maxRetriesPerRequest to be null when
 * using a manually-created ioredis connection.
 */
export const workerRedisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

/**
 * Creates a dedicated Redis subscriber connection.
 *
 * IMPORTANT:
 * A Redis connection that enters subscriber mode should not be used
 * for normal Redis commands at the same time.
 *
 * Every caller that creates one owns that connection and MUST close it.
 */
export const createRedisSubscriber = (): Redis => {
  return redisConnection.duplicate();
};

/**
 * Gracefully close one Redis connection.
 *
 * quit()
 *   - asks Redis to close gracefully.
 *
 * disconnect()
 *   - forcibly closes the connection and prevents further reconnecting.
 *
 * We use quit() first and fall back to disconnect() if graceful shutdown
 * cannot complete.
 */
const closeRedisConnection = async (
  connection: Redis,
): Promise<void> => {
  /**
   * Calling closeRedisConnection() twice should be harmless.
   */
  if (connection.status === "end") {
    return;
  }

  try {
    await connection.quit();
  } catch {
    /**
     * The Redis server may already be unavailable.
     *
     * In that situation quit() can fail, so make sure the local
     * connection is still terminated.
     */
    connection.disconnect();
  }
};

/**
 * Close all application-owned Redis connections.
 *
 * This should be called exactly once during application shutdown.
 */
export const closeRedisConnections = async (): Promise<void> => {
  await Promise.allSettled([
    closeRedisConnection(redisConnection),
    closeRedisConnection(workerRedisConnection),
  ]);
};
import Redis from "ioredis";
import { dbKeys } from "../conifg/db.keys";
import { Logger } from "../utils/Logger.util";

let redisClient: Redis | null = null;

export function connectRedis(): Redis {
  if (redisClient) {
    return redisClient;
  }

  try {
    let client: Redis;

    if (process.env.REDIS_URL) {
      client = new Redis(process.env.REDIS_URL);
    } else {
      client = new Redis({
        host: dbKeys.redis.host,
        port: dbKeys.redis.port,
        password: dbKeys.redis.password || undefined,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000); // max 2s
          return delay;
        },
      });
    }

    // Event listeners
    client.on("connect", () => {
      Logger.info("🔌 Redis connected via ioredis");
    });

    client.on("ready", () => {
      Logger.info("✅ Redis ready");
    });

    client.on("error", (err) => {
      Logger.error("❌ Redis error:", err.message);
    });

    client.on("close", () => {
      Logger.warn("⚠️ Redis connection closed");
    });

    redisClient = client;
    return client;
  } catch (error) {
    Logger.error("💥 Failed to create Redis client:", error);
    throw new Error("Redis initialization failed");
  }
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error("Redis client not initialized. Call connectRedis() first.");
  }
  return redisClient;
}

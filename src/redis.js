import { createClient } from "redis";
import { config } from "./config.js";

export const redis = createClient({ url: config.redisUrl });
export const redisSubscriber = createClient({ url: config.redisUrl });

redis.on("error", (err) => {
  console.error("Redis client error", err);
});

redisSubscriber.on("error", (err) => {
  console.error("Redis subscriber error", err);
});

export async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }

  if (!redisSubscriber.isOpen) {
    await redisSubscriber.connect();
  }
}

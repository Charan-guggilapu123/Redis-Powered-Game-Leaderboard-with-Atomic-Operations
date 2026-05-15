import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.API_PORT || 3000),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  sessionTtlSeconds: 1800,
  eventChannel: "game-events",
  leaderboardKey: "leaderboard:global"
};

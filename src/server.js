import express from "express";
import { v4 as uuidv4 } from "uuid";
import { config } from "./config.js";
import { connectRedis, redis, redisSubscriber } from "./redis.js";
import { gameRoundKey, sessionKey, submissionsKey, userSessionsKey } from "./keys.js";
import {
  LUA_DELETE_SESSION,
  LUA_PROCESS_SUBMISSION,
  LUA_REPLACE_USER_SESSIONS
} from "./lua.js";

const app = express();
app.use(express.json());

const sseClients = new Set();
let isSubscribedToEvents = false;

function parseScore(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function mapPlayerEntry(index, values) {
  return {
    rank: index + 1,
    playerId: values[0],
    score: parseScore(values[1])
  };
}

async function getRankedRange(startRankOneBased, count) {
  if (count <= 0) {
    return [];
  }

  const start = Math.max(0, startRankOneBased - 1);
  const end = start + count - 1;
  const rows = await redis.zRangeWithScores(config.leaderboardKey, start, end, { REV: true });
  return rows.map((row, idx) => ({
    rank: start + idx + 1,
    playerId: row.value,
    score: parseScore(row.score)
  }));
}

async function ensureRedisEventSubscription() {
  if (isSubscribedToEvents) {
    return;
  }

  await redisSubscriber.subscribe(config.eventChannel, (rawMessage) => {
    let payload;
    try {
      payload = JSON.parse(rawMessage);
    } catch (_err) {
      payload = { event: "unknown", data: rawMessage };
    }

    const eventName = payload.event || "message";
    const eventData = JSON.stringify(payload.data ?? payload);

    for (const res of sseClients) {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${eventData}\n\n`);
    }
  });

  isSubscribedToEvents = true;
}

app.get("/health", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.status(200).json({ status: "ok", redis: pong });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { userId, ipAddress, deviceType } = req.body || {};

  if (!userId || !ipAddress || !deviceType) {
    return res.status(400).json({ error: "userId, ipAddress and deviceType are required" });
  }

  const sessionId = uuidv4();
  const createdAt = new Date().toISOString();
  const userSet = userSessionsKey(userId);
  const sessKey = sessionKey(sessionId);

  await redis.eval(LUA_REPLACE_USER_SESSIONS, {
    keys: [userSet, sessKey],
    arguments: [
      sessionId,
      String(userId),
      createdAt,
      createdAt,
      String(ipAddress),
      String(deviceType),
      String(config.sessionTtlSeconds)
    ]
  });

  return res.status(201).json({ sessionId });
});

app.post("/api/leaderboard/scores", async (req, res) => {
  const { playerId, points } = req.body || {};

  if (!playerId || typeof points !== "number") {
    return res.status(400).json({ error: "playerId and numeric points are required" });
  }

  const newScore = await redis.zIncrBy(config.leaderboardKey, points, String(playerId));
  const scoreNumber = parseScore(newScore);

  await redis.publish(
    config.eventChannel,
    JSON.stringify({
      event: "leaderboard_updated",
      data: { playerId: String(playerId), newScore: scoreNumber }
    })
  );

  return res.status(200).json({ playerId: String(playerId), newScore: scoreNumber });
});

app.get("/api/leaderboard/top/:count", async (req, res) => {
  const count = Number(req.params.count);

  if (!Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ error: "count must be a positive integer" });
  }

  const rows = await redis.zRangeWithScores(config.leaderboardKey, 0, count - 1, { REV: true });
  const result = rows.map((row, idx) => ({
    rank: idx + 1,
    playerId: row.value,
    score: parseScore(row.score)
  }));

  return res.status(200).json(result);
});

app.get("/api/leaderboard/player/:playerId", async (req, res) => {
  const playerId = String(req.params.playerId);
  const rankZeroBased = await redis.zRevRank(config.leaderboardKey, playerId);

  if (rankZeroBased === null) {
    return res.status(404).json({ error: "player not found" });
  }

  const scoreRaw = await redis.zScore(config.leaderboardKey, playerId);
  const totalPlayers = await redis.zCard(config.leaderboardKey);

  const rank = rankZeroBased + 1;
  const percentile =
    totalPlayers <= 1 ? 100 : Number((((totalPlayers - rank) / (totalPlayers - 1)) * 100).toFixed(2));

  const aboveStartRank = Math.max(1, rank - 2);
  const aboveCount = rank - aboveStartRank;
  const above = await getRankedRange(aboveStartRank, aboveCount);

  const belowStartRank = rank + 1;
  const below = await getRankedRange(belowStartRank, 2);

  return res.status(200).json({
    playerId,
    score: parseScore(scoreRaw),
    rank,
    percentile,
    nearbyPlayers: {
      above,
      below
    }
  });
});

app.post("/api/game/submit", async (req, res) => {
  const { gameId, roundId, playerId, answer } = req.body || {};

  if (!gameId || !roundId || !playerId || typeof answer !== "string") {
    return res.status(400).json({ error: "gameId, roundId, playerId and answer are required" });
  }

  const roundKey = gameRoundKey(String(gameId), String(roundId));
  const subsKey = submissionsKey(String(gameId), String(roundId));

  const scriptResult = await redis.eval(LUA_PROCESS_SUBMISSION, {
    keys: [roundKey, subsKey, config.leaderboardKey],
    arguments: [String(playerId), answer, String(Math.floor(Date.now() / 1000))]
  });

  const [status, payload] = scriptResult;

  if (status === "ERROR" && payload === "DUPLICATE_SUBMISSION") {
    return res.status(400).json({ status: "ERROR", code: "DUPLICATE_SUBMISSION" });
  }

  if (status === "ERROR" && payload === "ROUND_EXPIRED") {
    return res.status(403).json({ status: "ERROR", code: "ROUND_EXPIRED" });
  }

  const newScore = parseScore(payload);

  await redis.publish(
    config.eventChannel,
    JSON.stringify({
      event: "leaderboard_updated",
      data: { playerId: String(playerId), newScore }
    })
  );

  return res.status(200).json({ status: "SUCCESS", newScore });
});

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  await ensureRedisEventSubscription();

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

app.get("/api/admin/sessions/user/:userId", async (req, res) => {
  const userId = String(req.params.userId);
  const sessionIds = await redis.sMembers(userSessionsKey(userId));

  const sessions = [];
  for (const sid of sessionIds) {
    const data = await redis.hGetAll(sessionKey(sid));
    if (!data || Object.keys(data).length === 0) {
      continue;
    }

    await redis.expire(sessionKey(sid), config.sessionTtlSeconds);
    await redis.hSet(sessionKey(sid), { lastActive: new Date().toISOString() });

    sessions.push({
      sessionId: sid,
      ipAddress: data.ipAddress || "",
      lastActive: data.lastActive || "",
      deviceType: data.deviceType || ""
    });
  }

  return res.status(200).json(sessions);
});

app.delete("/api/admin/sessions/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const result = await redis.eval(LUA_DELETE_SESSION, {
    keys: [sessionKey(sessionId)],
    arguments: [sessionId]
  });

  if (Number(result) === 0) {
    return res.status(404).json({ error: "session not found" });
  }

  return res.status(204).send();
});

app.post("/api/admin/game-rounds", async (req, res) => {
  const { gameId, roundId, endTime, correctAnswer, points } = req.body || {};

  if (!gameId || !roundId || !endTime) {
    return res.status(400).json({ error: "gameId, roundId, endTime are required" });
  }

  const key = gameRoundKey(String(gameId), String(roundId));
  await redis.hSet(key, {
    endTime: String(endTime),
    correctAnswer: String(correctAnswer || ""),
    points: String(Number(points || 0))
  });

  return res.status(201).json({ status: "CREATED", key });
});

async function start() {
  await connectRedis();
  await ensureRedisEventSubscription();

  app.listen(config.port, () => {
    console.log(`API running on port ${config.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});

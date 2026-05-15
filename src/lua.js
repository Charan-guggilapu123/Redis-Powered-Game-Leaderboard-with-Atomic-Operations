export const LUA_REPLACE_USER_SESSIONS = `
local userSessionsKey = KEYS[1]
local newSessionKey = KEYS[2]

local newSessionId = ARGV[1]
local userId = ARGV[2]
local createdAt = ARGV[3]
local lastActive = ARGV[4]
local ipAddress = ARGV[5]
local deviceType = ARGV[6]
local ttlSeconds = tonumber(ARGV[7])

local existingSessions = redis.call('SMEMBERS', userSessionsKey)
for _, sessionId in ipairs(existingSessions) do
  redis.call('DEL', 'session:' .. sessionId)
end

redis.call('DEL', userSessionsKey)
redis.call('HSET', newSessionKey,
  'userId', userId,
  'createdAt', createdAt,
  'lastActive', lastActive,
  'ipAddress', ipAddress,
  'deviceType', deviceType
)
redis.call('EXPIRE', newSessionKey, ttlSeconds)
redis.call('SADD', userSessionsKey, newSessionId)

return 1
`;

export const LUA_PROCESS_SUBMISSION = `
local roundKey = KEYS[1]
local submissionsKey = KEYS[2]
local leaderboardKey = KEYS[3]

local playerId = ARGV[1]
local answer = ARGV[2]
local nowUnix = tonumber(ARGV[3])

local endTime = tonumber(redis.call('HGET', roundKey, 'endTime'))
if (not endTime) then
  return {'ERROR', 'ROUND_EXPIRED'}
end

if nowUnix >= endTime then
  return {'ERROR', 'ROUND_EXPIRED'}
end

if redis.call('SISMEMBER', submissionsKey, playerId) == 1 then
  return {'ERROR', 'DUPLICATE_SUBMISSION'}
end

local correctAnswer = redis.call('HGET', roundKey, 'correctAnswer')
local basePoints = tonumber(redis.call('HGET', roundKey, 'points')) or 0
local awardedPoints = 0

if correctAnswer and answer == correctAnswer then
  awardedPoints = basePoints
end

redis.call('SADD', submissionsKey, playerId)
local newScore = redis.call('ZINCRBY', leaderboardKey, awardedPoints, playerId)

return {'SUCCESS', tostring(newScore)}
`;

export const LUA_DELETE_SESSION = `
local sessionKey = KEYS[1]
local sessionId = ARGV[1]

local userId = redis.call('HGET', sessionKey, 'userId')
if not userId then
  return 0
end

redis.call('DEL', sessionKey)
redis.call('SREM', 'user_sessions:' .. userId, sessionId)
return 1
`;

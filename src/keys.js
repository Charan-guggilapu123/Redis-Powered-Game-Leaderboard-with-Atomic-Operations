export const sessionKey = (sessionId) => `session:${sessionId}`;
export const userSessionsKey = (userId) => `user_sessions:${userId}`;
export const gameRoundKey = (gameId, roundId) => `game_round:${gameId}:${roundId}`;
export const submissionsKey = (gameId, roundId) => `submissions:${gameId}:${roundId}`;

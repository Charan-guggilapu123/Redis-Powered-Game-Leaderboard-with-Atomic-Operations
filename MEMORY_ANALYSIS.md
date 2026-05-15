# Redis Memory Analysis

This document captures memory behavior for session hashes and a very large leaderboard sorted set.

## Environment

- Redis image: `redis:7-alpine` (Redis 7.x)
- Host setting baseline: default Redis memory encoding thresholds
- Test keys:
  - Session hash: `session:mem-test-1`
  - Leaderboard zset: `leaderboard:global`

## 1) Hash Memory Usage (Session Object)

Session schema:
- userId
- createdAt
- lastActive
- ipAddress
- deviceType

Example commands used:

```bash
HSET session:mem-test-1 userId u-1 createdAt 2026-05-14T10:00:00.000Z lastActive 2026-05-14T10:00:00.000Z ipAddress 1.2.3.4 deviceType desktop
MEMORY USAGE session:mem-test-1
OBJECT ENCODING session:mem-test-1
```

Observed result (representative):
- `OBJECT ENCODING session:mem-test-1` -> `listpack`
- `MEMORY USAGE session:mem-test-1` -> ~200-320 bytes depending on string lengths

Conclusion:
- Hashes remain compact with `listpack` encoding for small field counts and small values.
- This is efficient for high session volume.

## 2) Sorted Set Memory Usage (100k+ Players)

Dataset generation pattern:

```bash
for i in $(seq 1 100000); do
  redis-cli ZADD leaderboard:global $i player-$i > /dev/null
done
```

Commands used:

```bash
MEMORY USAGE leaderboard:global
OBJECT ENCODING leaderboard:global
ZCARD leaderboard:global
```

### Baseline (default thresholds)

Representative output:
- `ZCARD leaderboard:global` -> `100000`
- `OBJECT ENCODING leaderboard:global` -> `skiplist`
- `MEMORY USAGE leaderboard:global` -> typically tens of MB (depends on member lengths and allocator behavior)

Note:
- For large zsets, Redis naturally uses `skiplist` + hash table structures.

## 3) Forcing Non-Compact Encoding Threshold Change

Historically, Redis exposed `zset-max-ziplist-entries` and `zset-max-ziplist-value`.
In modern Redis, these map to `zset-max-listpack-entries` and `zset-max-listpack-value`.

To force skiplist earlier for small sets:

```bash
CONFIG SET zset-max-ziplist-entries 1
CONFIG SET zset-max-ziplist-value 1
```

(Equivalent modern parameters: `zset-max-listpack-entries`, `zset-max-listpack-value`.)

### Before vs After (small test zset)

Small zset key creation:

```bash
DEL leaderboard:small
ZADD leaderboard:small 10 p1 20 p2 30 p3
OBJECT ENCODING leaderboard:small
MEMORY USAGE leaderboard:small
```

Before threshold change (default):
- Encoding: `listpack`
- Memory: lower (compact contiguous storage)

After threshold change (forced):
- Encoding: `skiplist`
- Memory: higher for same cardinality due to node/index overhead

Conclusion:
- `listpack` is memory-efficient for small zsets.
- `skiplist` has higher memory cost but supports scalable performance characteristics across larger collections.

## 4) Encoding Output Summary

Representative `OBJECT ENCODING` outputs captured across tests:

- `OBJECT ENCODING session:mem-test-1` -> `listpack`
- `OBJECT ENCODING leaderboard:small` (default thresholds) -> `listpack`
- `OBJECT ENCODING leaderboard:small` (forced low thresholds) -> `skiplist`
- `OBJECT ENCODING leaderboard:global` (100k players) -> `skiplist`

## 5) Practical Guidance for This Project

- Keep session objects as hashes with short field values for compact memory.
- Use one global zset for leaderboard reads/writes (`O(logN)` updates, efficient top/rank queries).
- Keep default listpack thresholds unless profiling shows a reason to tune.
- For deterministic tests of encoding transitions, lower threshold values via `CONFIG SET` in a controlled test environment.

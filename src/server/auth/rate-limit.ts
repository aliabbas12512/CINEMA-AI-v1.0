import type { Redis } from "ioredis";

/**
 * Fixed-window rate limiter on Redis. Fails CLOSED for generation endpoints
 * (no Redis -> no expensive work) and is shared across app instances.
 */
export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSec + 5);
  const retryAfterSec = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec };
}

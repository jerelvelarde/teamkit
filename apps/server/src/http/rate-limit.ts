import type { IncomingMessage } from "node:http";
import type { Context } from "hono";

export interface RateLimit {
  /** Requests a key may make in a burst. */
  burst: number;
  /** Requests a key regains per minute, up to `burst`. */
  perMinute: number;
}

export interface TokenBucket {
  /** Takes one token for `key`. Returns 0 when allowed, else the ms until a token is free. */
  take(key: string): number;
}

/** Keys tracked at most; past this, the least recently used key is dropped (it starts over with a full bucket). */
const MAX_KEYS = 10_000;

/** An in-memory token bucket per key. State is per process and lost on restart. */
export function tokenBucket(limit: RateLimit, now: () => number = Date.now): TokenBucket {
  const msPerToken = 60_000 / limit.perMinute;
  const buckets = new Map<string, { tokens: number; at: number }>();

  const level = (b: { tokens: number; at: number }, t: number) =>
    Math.min(limit.burst, b.tokens + (t - b.at) / msPerToken);

  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (b) {
        buckets.delete(key); // re-inserted below, so the map stays in least-recently-used order
      } else {
        if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value!);
        b = { tokens: limit.burst, at: t };
      }
      buckets.set(key, b);
      b.tokens = level(b, t);
      b.at = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return 0;
      }
      return Math.ceil((1 - b.tokens) * msPerToken);
    },
  };
}

/**
 * The address of the connection a request came in on. Forwarding headers are ignored:
 * any client can write them. Requests that did not come over a socket share one key.
 */
export function clientAddress(c: Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

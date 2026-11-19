import type { Db, Tx } from "../db/pool.js";

/** deadlock_detected and serialization_failure: Postgres rolled the transaction back, so rerunning it is safe. */
const RETRYABLE: ReadonlySet<string> = new Set(["40P01", "40001"]);
export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 10;

export function isRetryable(e: unknown): boolean {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && RETRYABLE.has(code);
}

/**
 * Runs `fn` in a transaction, rerunning the whole transaction when Postgres aborts
 * it as a deadlock victim or a serialization failure. Use it for transactions that
 * lock several rows, where some lock orders cannot be made consistent (completing a
 * task locks it and then its dependents). `fn` must only act through `tx`: it may
 * run up to MAX_ATTEMPTS times. Other errors, and the last retryable one, are thrown.
 */
export async function withRetry<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db.begin(fn)) as T;
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
      // Jittered so two victims of the same cycle do not collide again.
      const delay = BASE_DELAY_MS * attempt * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

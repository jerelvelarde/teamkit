import type { Notifier } from "../notifier.js";

/** First wait after a failed pass with no Retry-After; it doubles per failure up to the maximum. */
const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * Runs `pass` on every board event and every `pollMs`. After a failed pass it waits (the pass's
 * `afterMs`, else 1 s doubling per failure, capped at `maxBackoffMs`) before the next one, and
 * events and polls in that time only mark work as pending. A failure streak is logged once,
 * prefixed with `label`.
 */
export function startPassLoop(o: {
  label: string;
  notifier: Notifier;
  pollMs: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
  pass: () => Promise<{ retry: { reason: string; afterMs: number | null } | null }>;
}): { stop(): Promise<void> } {
  const maxBackoffMs = o.maxBackoffMs ?? MAX_BACKOFF_MS;
  let stopped = false;
  let dirty = true;
  let running: Promise<void> | null = null;
  let pausedUntil = 0;
  let wake: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let streakReason: string | null = null;

  const loop = async () => {
    while (dirty && !stopped) {
      dirty = false;
      let retry: { reason: string; afterMs: number | null } | null;
      try {
        retry = (await o.pass()).retry;
      } catch (err) {
        retry = { reason: `pass failed: ${err instanceof Error ? err.message : String(err)}`, afterMs: null };
      }
      if (retry) {
        failures++;
        const backoff = retry.afterMs ?? BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 20);
        const delay = Math.min(backoff, maxBackoffMs);
        pausedUntil = Date.now() + delay;
        if (retry.reason !== streakReason) {
          o.log?.(`${o.label}: paused, ${retry.reason}; retrying in ${Math.ceil(delay / 1000)} s`);
          streakReason = retry.reason;
        }
        dirty = true;
        return;
      }
      if (failures > 0) o.log?.(`${o.label}: resumed after ${failures} failed pass(es)`);
      failures = 0;
      streakReason = null;
    }
  };

  const pass = () => {
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      dirty = true;
      wake ??= setTimeout(() => {
        wake = null;
        pass();
      }, wait);
      return;
    }
    running = loop().finally(() => {
      running = null;
      if (dirty) pass();
    });
  };

  const unsubscribe = o.notifier.onEvent(() => {
    dirty = true;
    pass();
  });
  const timer = setInterval(() => {
    dirty = true;
    pass();
  }, o.pollMs);
  pass();

  return {
    async stop() {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      if (wake) clearTimeout(wake);
      await running;
    },
  };
}

import { createHash } from "node:crypto";
import postgres from "postgres";

export const TRIGGERS_LOCK = "teamkit:triggers";
export const SLACK_OUTBOUND_LOCK = "teamkit:slack-outbound";

export interface SingletonOptions {
  /** Database url. The lock lives on its own connection, apart from the pool. */
  url: string;
  /** Lock name, also used in the "another instance holds" line. */
  name: string;
  /** Starts the work once this process holds the lock. */
  start: () => Promise<{ stop(): Promise<void> }> | { stop(): Promise<void> };
  /** How often a process without the lock tries again, and how often a holder checks it still has it. Default 30000. */
  retryMs?: number;
  log?: (line: string) => void;
}

export interface Singleton {
  /** Resolves after the first attempt: the work started, or another instance holds the lock. */
  ready: Promise<void>;
  held(): boolean;
  /** Stops the work, releases the lock and closes its connection. */
  stop(): Promise<void>;
}

/** A stable 64-bit key for a lock name. */
export function lockKey(name: string): string {
  return createHash("sha256").update(name).digest().readBigInt64BE(0).toString();
}

/**
 * Runs `start` in at most one process per database. The process holds a session-level
 * `pg_try_advisory_lock` on a dedicated connection; the others retry every `retryMs`. The
 * lock goes with the connection, so a crashed holder frees it. postgres.js would quietly
 * reconnect a dropped connection without the lock, so the holder compares the backend pid
 * on every tick and gives the work up when it changed.
 */
export function startSingleton(o: SingletonOptions): Singleton {
  const retryMs = o.retryMs ?? 30_000;
  const key = lockKey(o.name);
  // No idle timeout and no max lifetime: either one would close the connection and drop the lock.
  const lockDb = postgres(o.url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {} });
  let work: { stop(): Promise<void> } | null = null;
  let pid: number | null = null;
  let stopped = false;
  let streak = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tick: Promise<void> = Promise.resolve();

  async function release(): Promise<void> {
    const w = work;
    work = null;
    pid = null;
    await w?.stop();
  }

  async function attempt(): Promise<void> {
    try {
      if (work) {
        const [row] = await lockDb`select pg_backend_pid() as pid`;
        if (row?.pid === pid) return;
        o.log?.(`${o.name}: lost the lock (its connection was replaced); stopping`);
        await release();
        return;
      }
      const [row] = await lockDb`select pg_backend_pid() as pid, pg_try_advisory_lock(${key}::bigint) as ok`;
      if (!row?.ok) {
        if (!streak) o.log?.(`${o.name}: another instance holds the lock; retrying every ${Math.ceil(retryMs / 1000)} s`);
        streak = true;
        return;
      }
      streak = false;
      if (stopped) return;
      pid = row.pid as number;
      work = await o.start();
    } catch (err) {
      pid = null;
      o.log?.(`${o.name}: ${err instanceof Error ? err.message : String(err)}; retrying`);
      await release().catch(() => {});
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      tick = attempt().finally(schedule);
    }, retryMs);
  }

  const ready = (tick = attempt()).finally(schedule);

  return {
    ready,
    held: () => work !== null,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await tick;
      await release();
      await lockDb.end({ timeout: 5 });
    },
  };
}

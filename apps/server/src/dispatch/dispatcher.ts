import { isBoardError, type Claim } from "@copilotkit/teamkit-protocol";
import type { Notifier } from "../notifier.js";
import { claimTask } from "../store/claims.js";
import { agentAuthContext, listDispatchable, type RegisteredAgent } from "./registry.js";
import { runClaim, type RunClaimOptions } from "./run-claim.js";

export interface DispatcherOptions extends Omit<RunClaimOptions, "signal"> {
  notifier: Notifier;
  /** Claims run at once. Default 4. */
  concurrency?: number;
  /** Scan interval, on top of the scans notifier wake-ups start. Default 5000. */
  pollMs?: number;
  /**
   * Notifier wake-ups start at most one scan per this many ms; the ones in between fold into
   * one scan at the end of the window. Every logged event wakes the notifier, a streaming run
   * included, and the payload names no kind to filter on. Default 250.
   */
  wakeEveryMs?: number;
  /** A released task waits retryDelayMs × (its attempts before that run + 1) before it is tried again. Default 2000. */
  retryDelayMs?: number;
}

export interface Dispatcher {
  /** Aborts in-flight runs (each releases its claim without counting an attempt), waits for them, stops scanning. */
  stop(): Promise<void>;
  /**
   * Resolves once no run is in flight, no released task is waiting out its retry delay, and a
   * scan begun after this call found nothing to start. Resolves when the dispatcher stops.
   */
  idle(): Promise<void>;
}

/** How long a task its agent may not claim is left alone. It does not keep idle() waiting. */
const REFUSED_BACKOFF_MS = 60_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs ready tasks routed to registered agents (task label `agent`, else the room's agent):
 * scans on notifier events (at most one scan per wakeEveryMs) and every pollMs, claims each
 * task as its agent without opening a run, and hands the claim to runClaim, at most
 * `concurrency` at once. Claims are atomic, so dispatchers sharing a database never run one
 * task twice.
 */
export function startDispatcher(o: DispatcherOptions): Dispatcher {
  const { notifier, concurrency = 4, pollMs = 5000, retryDelayMs = 2000, wakeEveryMs = 250, ...rest } = o;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`dispatcher concurrency must be an integer >= 1, got ${concurrency}`);
  }
  const log = rest.log ?? ((line: string) => console.log(line));
  const runOptions: Omit<RunClaimOptions, "signal"> = { ...rest, log };
  const { db } = rest;

  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Released tasks waiting out their retry delay. */
  const retrying = new Map<string, NodeJS.Timeout>();
  /** Tasks whose claim was forbidden → when to try again. Kept past that, so a refusal is logged once. */
  const refused = new Map<string, number>();
  let waiters: (() => void)[] = [];
  /** A scan is owed. */
  let dirty = true;
  /** The last finished scan found nothing to start. */
  let quiet = false;
  let scanning: Promise<void> | null = null;
  /** A notifier wake-up waiting for its scan. */
  let wake: NodeJS.Timeout | null = null;
  let lastWake = 0;
  let stopped = false;
  let stopping: Promise<void> | null = null;

  function wakeIdle(): void {
    if (waiters.length === 0) return;
    if (dirty || scanning || wake || !quiet || running.size > 0 || retrying.size > 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }

  function backOff(taskId: string, ms: number): void {
    retrying.set(
      taskId,
      setTimeout(() => {
        retrying.delete(taskId);
        requestScan();
      }, ms),
    );
  }

  function start(agent: RegisteredAgent, claim: Claim): void {
    const taskId = claim.task.id;
    const abort = new AbortController();
    // A claim that lands while stopping still goes through runClaim, which releases it at once.
    if (stopped) abort.abort();
    const done = (async () => {
      try {
        const result = await runClaim({ ...runOptions, signal: abort.signal }, agent, claim);
        // Set before the run leaves `running`, so idle() never sees the task as settled.
        if (result === "released" && !stopped) backOff(taskId, retryDelayMs * (claim.task.attempts + 1));
      } catch (e) {
        // The store failed while running or settling; the lease lapses and the reaper hands the task back.
        log(`${agent.name} ${taskId}: run failed: ${errorMessage(e)}`);
      } finally {
        running.delete(taskId);
        requestScan();
      }
    })();
    running.set(taskId, { abort, done });
  }

  /** Claims dispatchable tasks into free slots. True when it found nothing to start. */
  async function scanOnce(): Promise<boolean> {
    const free = concurrency - running.size;
    if (free <= 0) return false;
    // Skipped tasks still come back from the query: ask for enough rows to see past them.
    const limit = free * 2 + retrying.size + refused.size;
    let found: { taskId: string; agent: RegisteredAgent }[];
    try {
      found = await listDispatchable(db, limit);
    } catch (e) {
      log(`dispatcher: scan failed: ${errorMessage(e)}`);
      return false;
    }
    if (found.length < limit) {
      // Every dispatchable task came back: a refused one missing from it is gone or rerouted.
      const listed = new Set(found.map((f) => f.taskId));
      for (const id of refused.keys()) if (!listed.has(id)) refused.delete(id);
    }
    const now = Date.now();
    let started = 0;
    let failed = false;
    for (const { taskId, agent } of found) {
      if (stopped || running.size >= concurrency) break;
      if (running.has(taskId) || retrying.has(taskId) || (refused.get(taskId) ?? 0) > now) continue;
      let claim: Claim;
      try {
        claim = await claimTask(db, agentAuthContext(agent), taskId, { opensRun: false });
      } catch (e) {
        if (isBoardError(e) && (e.code === "task_claimed" || e.code === "invalid_state")) continue;
        if (isBoardError(e) && e.code === "forbidden") {
          if (!refused.has(taskId)) log(`${agent.name} ${taskId}: not dispatched: ${e.message}`);
          refused.set(taskId, Date.now() + REFUSED_BACKOFF_MS);
          continue;
        }
        log(`${agent.name} ${taskId}: claim failed: ${errorMessage(e)}`);
        failed = true;
        continue;
      }
      refused.delete(taskId);
      start(agent, claim);
      started++;
    }
    return started === 0 && !failed;
  }

  /** Scans now, or once more after the scan in progress; requests made meanwhile coalesce. */
  function requestScan(): void {
    if (stopped) return;
    dirty = true;
    if (scanning) return;
    scanning = (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          quiet = await scanOnce();
        }
      } catch (e) {
        quiet = false;
        log(`dispatcher: scan failed: ${errorMessage(e)}`);
      } finally {
        scanning = null;
      }
      wakeIdle();
    })();
  }

  /** Throttles notifier wake-ups to one scan per wakeEveryMs, keeping the last one. */
  function onWake(): void {
    if (stopped || wake) return;
    wake = setTimeout(
      () => {
        wake = null;
        lastWake = Date.now();
        requestScan();
      },
      Math.max(0, lastWake + wakeEveryMs - Date.now()),
    );
  }

  const unsubscribe = notifier.onEvent(onWake);
  const poll = setInterval(requestScan, pollMs);
  requestScan();

  return {
    stop() {
      stopping ??= (async () => {
        stopped = true;
        unsubscribe();
        clearInterval(poll);
        if (wake) clearTimeout(wake);
        wake = null;
        for (const timer of retrying.values()) clearTimeout(timer);
        retrying.clear();
        // A claim the scan in progress takes starts its run already aborted.
        await scanning;
        const runs = [...running.values()];
        for (const r of runs) r.abort.abort();
        await Promise.all(runs.map((r) => r.done));
        const ready = waiters;
        waiters = [];
        for (const resolve of ready) resolve();
      })();
      return stopping;
    },
    idle() {
      if (stopping) return stopping;
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        requestScan();
      });
    },
  };
}

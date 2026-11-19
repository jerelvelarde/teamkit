import { isBoardError, type BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { getAgent, type RegisteredAgent } from "../dispatch/registry.js";
import type { Notifier } from "../notifier.js";
import { listEvents } from "../store/events.js";
import { loadThreadInfo } from "../store/rows.js";
import { findLeadThread, postTriggerDisabled, wakeLead } from "./lead.js";
import { advanceTrigger, listStoredTriggers, type StoredTrigger } from "./store.js";
import { deliverWebhook } from "./webhook.js";

const DEFAULT_POLL_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_BATCH = 100;
const DEFAULT_WAKE_LIMIT = { max: 20, windowMs: 60_000 };

export interface TriggerRunnerOptions {
  db: Db;
  notifier: Notifier;
  fetch?: typeof fetch;
  pollMs?: number;
  retryDelayMs?: number;
  batch?: number;
  webhook?: { attempts?: number; backoffMs?: number[]; timeoutMs?: number };
  /** An agent trigger that would wake its agent more than `max` times in `windowMs` is disabled instead. Default 20 per 60 s. */
  wakeLimit?: { max: number; windowMs: number };
  log?: (l: string) => void;
}

/** `disabled`: the wake cap disabled the trigger; the event stays undelivered. */
type Step = "delivered" | "skipped" | "stalled" | "disabled";

/** Log lines name the trigger and the event cursor; never a secret, a webhook url or an agent header. */
function say(o: TriggerRunnerOptions, t: StoredTrigger, line: string): void {
  o.log?.(`triggers: ${t.name}: ${line}`);
}

function describe(err: unknown, t: StoredTrigger): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return t.secret ? text.split(t.secret).join("[secret]") : text;
}

function maxCursor(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** The trigger row still exists and is enabled: a removal or a disable stops a pass at the next event. */
async function stillEnabled(db: Db, id: string): Promise<boolean> {
  const [row] = await db`select enabled from triggers where id = ${id}`;
  return row?.enabled === true;
}

async function labelsMatch(db: Db, labels: Record<string, string>, e: BoardEvent): Promise<boolean> {
  if (e.threadId === null) return false;
  const info = await loadThreadInfo(db, e.threadId);
  if (!info) return false;
  return Object.entries(labels).every(([k, v]) => info.labels[k] === v);
}

/** The agent caused the event, or it is on the agent's own lead thread: waking on it would wake on itself. */
async function isOwnEvent(db: Db, agent: RegisteredAgent, e: BoardEvent): Promise<boolean> {
  if (e.actor?.id === agent.actor.id) return true;
  return e.threadId !== null && e.threadId === (await findLeadThread(db, agent, e.room));
}

/**
 * Disables a trigger that hit the wake cap, says so loudly in the log, and notes it on the
 * agent's lead thread in the event's room. A trigger already disabled or removed is left be.
 */
async function disableRunaway(
  o: TriggerRunnerOptions,
  t: StoredTrigger,
  agent: RegisteredAgent,
  e: BoardEvent,
  limit: { max: number; windowMs: number },
): Promise<void> {
  const rows = await o.db`update triggers set enabled = false where id = ${t.id} and enabled returning id`;
  if (rows.length === 0) return;
  const why = `would wake ${agent.name} more than ${limit.max} times in ${limit.windowMs / 1000} s`;
  say(o, t, `DISABLED: it ${why}; holding at event ${e.cursor}. Re-enable with: teamkit triggers enable ${t.name}`);
  const text = `TeamKit disabled trigger ${t.name}: it ${why}. Re-enable it with \`teamkit triggers enable ${t.name}\`.`;
  try {
    await postTriggerDisabled(o.db, { agent, room: e.room, trigger: t, text });
  } catch (err) {
    say(o, t, `could not post the disabled note in ${e.room}: ${describe(err, t)}`);
  }
}

async function handleEvent(
  o: TriggerRunnerOptions,
  t: StoredTrigger,
  e: BoardEvent,
  signal: AbortSignal | undefined,
  wakes: number[],
): Promise<Step> {
  if (t.labels !== null && !(await labelsMatch(o.db, t.labels, e))) return "skipped";

  if (t.action.type === "webhook") {
    if (t.secret === null) throw new Error("webhook trigger has no signing secret");
    const r = await deliverWebhook(
      { url: t.action.url, secret: t.secret, triggerName: t.name, event: e },
      { fetch: o.fetch, ...o.webhook },
    );
    if (r.ok) return "delivered";
    const why = r.status === null ? "no response" : `status ${r.status}`;
    say(o, t, `webhook failed for event ${e.cursor} (${why} after ${r.attempts} attempts); will retry`);
    return "stalled";
  }

  const agent = await getAgent(o.db, t.action.agent);
  if (agent && (await isOwnEvent(o.db, agent, e))) return "skipped";
  if (!agent || !agent.enabled) {
    say(o, t, `agent ${t.action.agent} is ${agent ? "disabled" : "not registered"}; holding at event ${e.cursor}`);
    return "stalled";
  }
  const limit = o.wakeLimit ?? DEFAULT_WAKE_LIMIT;
  const now = Date.now();
  while (wakes.length > 0 && wakes[0]! <= now - limit.windowMs) wakes.shift();
  if (wakes.length >= limit.max) {
    await disableRunaway(o, t, agent, e, limit);
    return "disabled";
  }
  try {
    const outcome = await wakeLead(o.db, { agent, room: e.room, event: e, triggerId: t.id, signal, fetch: o.fetch });
    if (outcome.type === "transport_error" || outcome.type === "aborted") {
      // Not delivered: the same wake-up runs again on the next pass (or after a restart).
      say(o, t, `lead ${agent.name} not reached for event ${e.cursor} (${outcome.type}); will retry`);
      return "stalled";
    }
    if (outcome.type !== "success") say(o, t, `lead ${agent.name} ended event ${e.cursor} with ${outcome.type}`);
  } catch (err) {
    // A board refusal (say, the agent has no grant in that room) would refuse every
    // retry too; log it as a non-success and move on. It woke nothing, so the cap
    // does not count it. Anything else stalls.
    if (!isBoardError(err)) throw err;
    say(o, t, `lead ${agent.name} refused for event ${e.cursor} (${err.code})`);
    return "delivered";
  }
  wakes.push(Date.now());
  return "delivered";
}

/**
 * Follows one trigger's cursor through the event log. The cursor moves past an event
 * only once that event was delivered or filtered out, so a failure (or a crash before
 * the cursor write) repeats it rather than skipping it: delivery is at-least-once.
 * Updates `t.cursor` in place. `signal` (the runner's stop) ends the pass between
 * events and cancels a lead run in flight, which leaves its event undelivered.
 * `wakes` holds the times of this trigger's recent wake-ups, for the wake cap; pass the
 * same array to every pass of one trigger. The pass that hits the cap disables the
 * trigger and ends on that event, undelivered.
 */
export async function runTriggerOnce(
  o: TriggerRunnerOptions,
  t: StoredTrigger,
  signal?: AbortSignal,
  wakes: number[] = [],
): Promise<{ delivered: number; stalled: boolean }> {
  const batch = o.batch ?? DEFAULT_BATCH;
  let delivered = 0;
  for (;;) {
    const page = await listEvents(o.db, {
      after: t.cursor,
      room: t.room === "*" ? undefined : t.room,
      kinds: t.kinds,
      limit: batch,
    });
    for (const e of page.events) {
      if (signal?.aborted || !(await stillEnabled(o.db, t.id))) return { delivered, stalled: false };
      const step = await handleEvent(o, t, e, signal, wakes);
      if (step === "stalled") return { delivered, stalled: true };
      if (step === "disabled") return { delivered, stalled: false };
      if (step === "delivered") delivered++;
      await advanceTrigger(o.db, t.id, e.cursor);
      t.cursor = e.cursor;
    }
    // A short page is the end of the log for this filter. (listEvents hands back
    // `after` as the cursor of an empty page, so there is nothing further to advance to.)
    if (page.events.length < batch) return { delivered, stalled: false };
  }
}

interface Worker {
  /** The row as the latest scan read it. */
  trigger: StoredTrigger;
  /** The cursor this runner last advanced it to; a scan that read the row mid-pass may be behind it. */
  cursor: string;
  running: Promise<void> | null;
  dirty: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  retired: boolean;
  /** Recent wake-up times, for the wake cap. A retired worker forgets them. */
  wakes: number[];
}

/**
 * Runs every enabled trigger. Each trigger has its own worker, so a stalled webhook
 * or a slow lead never holds up another trigger, and a trigger's events go out
 * strictly in order, one pass at a time. Workers wake on every notifier callback and
 * every `pollMs` (coalesced); each scan re-reads the triggers, so adds, removals and
 * disables take effect on the next wake. A stalled worker retries after `retryDelayMs`.
 *
 * `idle()` starts a scan and resolves once that scan and every pass it started (or
 * re-ran) have finished: by then each enabled trigger has delivered, or tried and
 * stalled on, every event that existed when `idle()` was called. A worker waiting out
 * its retry delay is not counted as busy. `stop()` cancels lead runs in flight and
 * waits for every pass to end.
 */
export function startTriggers(o: TriggerRunnerOptions): { stop(): Promise<void>; idle(): Promise<void> } {
  const retryDelayMs = o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const workers = new Map<string, Worker>();
  const inflight = new Set<Promise<void>>();
  const stopping = new AbortController();
  let stopped = false;
  let scanDirty = false;
  let scanning: Promise<void> | null = null;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (scanning || inflight.size > 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  async function workerLoop(w: Worker): Promise<void> {
    do {
      w.dirty = false;
      const t: StoredTrigger = { ...w.trigger, cursor: maxCursor(w.trigger.cursor, w.cursor) };
      let stalled: boolean;
      try {
        stalled = (await runTriggerOnce(o, t, stopping.signal, w.wakes)).stalled;
      } catch (err) {
        say(o, t, `pass failed: ${describe(err, t)}; will retry`);
        stalled = true;
      }
      w.cursor = t.cursor;
      if (stalled) {
        if (!stopped && !w.retired) {
          w.retry = setTimeout(() => {
            w.retry = null;
            wake(w);
          }, retryDelayMs);
        }
        return;
      }
    } while (w.dirty && !stopped && !w.retired);
  }

  const wake = (w: Worker) => {
    if (stopped || w.retired || w.retry) return;
    if (w.running) {
      w.dirty = true;
      return;
    }
    const p = workerLoop(w).finally(() => {
      inflight.delete(p);
      w.running = null;
      if (w.retired && workers.get(w.trigger.id) === w) workers.delete(w.trigger.id);
      settle();
    });
    w.running = p;
    inflight.add(p);
  };

  async function scanLoop(): Promise<void> {
    while (scanDirty && !stopped) {
      scanDirty = false;
      let triggers: StoredTrigger[];
      try {
        triggers = await listStoredTriggers(o.db);
      } catch (err) {
        o.log?.(`triggers: reading triggers failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (stopped) return;
      const ids = new Set(triggers.map((t) => t.id));
      for (const [id, w] of workers) {
        if (ids.has(id)) continue;
        w.retired = true;
        w.wakes = [];
        if (w.retry) clearTimeout(w.retry);
        w.retry = null;
        if (!w.running) workers.delete(id);
      }
      for (const t of triggers) {
        let w = workers.get(t.id);
        if (w) {
          w.trigger = t;
          w.retired = false;
        } else {
          w = { trigger: t, cursor: t.cursor, running: null, dirty: false, retry: null, retired: false, wakes: [] };
          workers.set(t.id, w);
        }
        wake(w);
      }
    }
  }

  const scan = () => {
    if (stopped) return;
    scanDirty = true;
    if (scanning) return;
    const p = scanLoop().finally(() => {
      scanning = null;
      settle();
    });
    scanning = p;
  };

  const unsubscribe = o.notifier.onEvent(() => scan());
  const timer = setInterval(scan, o.pollMs ?? DEFAULT_POLL_MS);
  scan();

  return {
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        scan();
        settle();
      });
    },
    async stop() {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      for (const w of workers.values()) {
        if (w.retry) clearTimeout(w.retry);
        w.retry = null;
      }
      stopping.abort();
      await scanning;
      await Promise.all([...inflight]);
      settle();
    },
  };
}

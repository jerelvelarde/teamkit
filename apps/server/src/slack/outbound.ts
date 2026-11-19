import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { currentCursor, listEvents } from "../store/events.js";
import { loadTask } from "../store/task-load.js";
import { toSlackMessage } from "./blocks.js";
import { BlockedCard, OutcomeCard, type CardTask } from "./cards.js";
import { getServiceCursor, getSlackThread, saveSlackThread, setServiceCursor, slackRoomSettings } from "./mirror.js";

const CURSOR_NAME = "slack-outbound";
const PAGE = 100;
const DEFAULT_POLL_MS = 5000;
/** First wait after a failed pass with no Retry-After; it doubles per failure up to the maximum. */
const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;
/** A post that hangs this long counts as a network failure. */
const POST_TIMEOUT_MS = 15_000;

/**
 * Slack error codes that say nothing about the one post: a rate limit or an outage, or a token
 * or app setup problem that fails every post the same way until it is fixed. The event stays
 * and is posted once Slack accepts it. Any other Slack error is about this post (the channel is
 * gone, the bot was removed) and will not go away by retrying.
 */
const RETRYABLE_SLACK_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "ekm_access_denied",
]);

export interface OutboundOptions {
  db: Db;
  notifier: Notifier;
  slack: { token: string; apiBase?: string; fetch?: typeof fetch };
  publicUrl: string;
  pollMs?: number;
  /** Longest wait between passes after a failure, including a longer Retry-After (default 60 s). */
  maxBackoffMs?: number;
  log?: (line: string) => void;
}

/** What one pass did. `retry` is set when Slack or the network failed and the pass stopped. */
export interface OutboundPass {
  posted: number;
  retry: { reason: string; afterMs: number | null } | null;
}

type Message = { blocks: unknown[]; text: string };

type PostResult =
  | { kind: "ok"; ts: string }
  | { kind: "retry"; reason: string; afterMs: number | null }
  | { kind: "permanent"; reason: string };

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

/**
 * One chat.postMessage. The token only goes into the Authorization header; reasons carry the
 * HTTP status or Slack's error code, never the token.
 */
async function postMessage(o: OutboundOptions, body: { channel: string; thread_ts?: string } & Message): Promise<PostResult> {
  const doFetch = o.slack.fetch ?? fetch;
  const url = `${o.slack.apiBase ?? "https://slack.com/api"}/chat.postMessage`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${o.slack.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "retry", reason: `request failed (${err instanceof Error ? err.name : "error"})`, afterMs: null };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: "retry", reason: `http ${res.status}`, afterMs: retryAfterMs(res) };
  }
  if (!res.ok) return { kind: "permanent", reason: `http ${res.status}` };
  let json: { ok?: boolean; ts?: string; error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { kind: "retry", reason: "unreadable response", afterMs: null };
  }
  if (json.ok === true && typeof json.ts === "string") return { kind: "ok", ts: json.ts };
  const error = typeof json.error === "string" ? json.error : "unknown";
  if (RETRYABLE_SLACK_ERRORS.has(error)) {
    return { kind: "retry", reason: `slack error ${error}`, afterMs: retryAfterMs(res) };
  }
  return { kind: "permanent", reason: `slack error ${error}` };
}

/** Posts what one event calls for. "retry" leaves the event for the next pass. */
async function handleEvent(
  o: OutboundOptions,
  e: BoardEvent,
): Promise<{ kind: "done"; posted: 0 | 1 } | { kind: "retry"; reason: string; afterMs: number | null }> {
  const skip = { kind: "done", posted: 0 } as const;
  if (e.threadId === null) return skip;
  const taskId = e.threadId;
  const settings = await slackRoomSettings(o.db, e.room);
  if (settings.channel === null || settings.announce === "none") return skip;
  const task = await loadTask(o.db, taskId);
  if (!task) return skip;
  const card: CardTask = {
    id: taskId,
    room: e.room,
    state: task.state,
    brief: task.brief,
    url: `${o.publicUrl.replace(/\/+$/, "")}/t/${taskId}`,
  };

  const blocked = e.data as { interruptId?: string; kind?: string; question?: string; options?: string[] | null };
  // A question that was answered (or replaced) since: its buttons could only fail, and after a
  // pause (a rate limit, a bad token) the stale ones would arrive as a flood.
  if (e.kind === "task.blocked" && (task.state !== "blocked" || task.block?.interruptId !== blocked.interruptId)) {
    return skip;
  }
  const mirror = await getSlackThread(o.db, taskId);
  const inThread = mirror?.channel != null && mirror.ts != null;
  // Outside a thread the task already has, only a question (or, with announce "all", any
  // outcome) starts one at the top level.
  if (!inThread && !(e.kind === "task.blocked" || settings.announce === "all")) return skip;

  let message: Message;
  if (e.kind === "task.blocked") {
    const d = blocked;
    message = toSlackMessage(
      BlockedCard({
        task: card,
        interruptId: String(d.interruptId ?? ""),
        kind: d.kind === "awaiting_approval" ? "awaiting_approval" : "awaiting_input",
        question: String(d.question ?? ""),
        options: Array.isArray(d.options) ? d.options : [],
        askedBy: e.actor?.name ?? null,
      }),
    );
  } else if (e.kind === "task.completed") {
    message = toSlackMessage(OutcomeCard({ task: card, outcome: "completed", text: task.result ?? "" }));
  } else {
    const d = e.data as { reason?: string };
    message = toSlackMessage(OutcomeCard({ task: card, outcome: "failed", text: String(d.reason ?? "") }));
  }

  const channel = inThread ? (mirror.channel as string) : settings.channel;
  const result = await postMessage(o, {
    channel,
    ...(inThread ? { thread_ts: mirror.ts as string } : {}),
    ...message,
  });
  if (result.kind === "retry") return result;
  if (result.kind === "permanent") {
    o.log?.(`slack-outbound: dropped the ${e.kind} post for task ${taskId} to ${channel}: ${result.reason}`);
    return skip;
  }
  if (!inThread) {
    // The new top-level message starts the task's Slack thread. Its conversation key is left
    // for the first turn from that thread to fill in (the managed Channel's key is opaque);
    // a key the task already has, from the mention that created it, is kept.
    await saveSlackThread(o.db, { taskId, channel, ts: result.ts, conversationKey: null });
  }
  return { kind: "done", posted: 1 };
}

/**
 * One pass over events past the persisted "slack-outbound" cursor, in order. The cursor moves
 * past an event only once its post is done: Slack accepted it, refused it for good (logged
 * once, e.g. channel_not_found), or the event needs no post. A rate limit, a 5xx, a network
 * error or a bad token ends the pass with the cursor still before that event, so it is posted
 * on a later pass (see `retry`). Delivery is at-least-once: a crash between a post and its
 * cursor write repeats that one post.
 */
export async function processOutboundOnce(o: OutboundOptions): Promise<OutboundPass> {
  let after = await getServiceCursor(o.db, CURSOR_NAME);
  if (after === null) {
    // First run: start at the head; never replay history into Slack.
    await setServiceCursor(o.db, CURSOR_NAME, await currentCursor(o.db));
    return { posted: 0, retry: null };
  }
  let posted = 0;
  for (;;) {
    const page = await listEvents(o.db, {
      after,
      kinds: ["task.blocked", "task.completed", "task.failed"],
      limit: PAGE,
    });
    for (const e of page.events) {
      const r = await handleEvent(o, e);
      if (r.kind === "retry") return { posted, retry: { reason: r.reason, afterMs: r.afterMs } };
      posted += r.posted;
      await setServiceCursor(o.db, CURSOR_NAME, e.cursor);
    }
    if (page.events.length < PAGE) return { posted, retry: null };
    after = page.cursor;
  }
}

/**
 * Runs passes on every board event and every `pollMs`. After a failed pass it waits (Slack's
 * Retry-After, else 1 s doubling per failure, capped at `maxBackoffMs`) before the next one, and
 * events and polls in that time only mark work as pending. A failure streak is logged once.
 */
export async function startOutbound(o: OutboundOptions): Promise<{ stop(): Promise<void> }> {
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
      let retry: OutboundPass["retry"];
      try {
        retry = (await processOutboundOnce(o)).retry;
      } catch (err) {
        retry = { reason: `pass failed: ${err instanceof Error ? err.message : String(err)}`, afterMs: null };
      }
      if (retry) {
        failures++;
        const backoff = retry.afterMs ?? BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 20);
        const delay = Math.min(backoff, maxBackoffMs);
        pausedUntil = Date.now() + delay;
        if (retry.reason !== streakReason) {
          o.log?.(`slack-outbound: paused, ${retry.reason}; retrying in ${Math.ceil(delay / 1000)} s`);
          streakReason = retry.reason;
        }
        dirty = true;
        return;
      }
      if (failures > 0) o.log?.(`slack-outbound: resumed after ${failures} failed pass(es)`);
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
  }, o.pollMs ?? DEFAULT_POLL_MS);
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

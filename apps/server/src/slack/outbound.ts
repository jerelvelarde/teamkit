import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { currentCursor, listEvents } from "../store/events.js";
import { loadTask } from "../store/task-load.js";
import { toSlackMessage } from "./blocks.js";
import { BlockedCard, OutcomeCard, type CardTask } from "./cards.js";
import { getServiceCursor, getSlackThread, saveSlackThread, setServiceCursor, slackRoomSettings } from "./mirror.js";
import { startPassLoop } from "./pass-loop.js";
import { callSlack, type SlackApi } from "./web-api.js";

const CURSOR_NAME = "slack-outbound";
const PAGE = 100;
const DEFAULT_POLL_MS = 5000;

export interface OutboundOptions {
  db: Db;
  notifier: Notifier;
  slack: SlackApi;
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
  const sent = await callSlack(o.slack, "chat.postMessage", {
    channel,
    ...(inThread ? { thread_ts: mirror.ts as string } : {}),
    ...message,
  });
  if (sent.kind === "retry") return sent;
  // An ok with no ts cannot start or join a thread: treat it as a refusal of this one post.
  const result: { kind: "ok"; ts: string } | { kind: "permanent"; reason: string } =
    sent.kind === "ok"
      ? sent.ts === null
        ? { kind: "permanent", reason: "slack error no_ts" }
        : { kind: "ok", ts: sent.ts }
      : sent;
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

/** Runs outbound passes on every board event and every `pollMs`, backing off after a failed pass. */
export async function startOutbound(o: OutboundOptions): Promise<{ stop(): Promise<void> }> {
  return startPassLoop({
    label: "slack-outbound",
    notifier: o.notifier,
    pollMs: o.pollMs ?? DEFAULT_POLL_MS,
    ...(o.maxBackoffMs === undefined ? {} : { maxBackoffMs: o.maxBackoffMs }),
    ...(o.log === undefined ? {} : { log: o.log }),
    pass: () => processOutboundOnce(o),
  });
}

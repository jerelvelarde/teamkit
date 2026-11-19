import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { currentCursor, listEvents } from "../store/events.js";
import { getServiceCursor, setServiceCursor } from "./mirror.js";
import { NEWS_EVENT_KINDS, postNewsEvent } from "./news-posts.js";
import { TASK_EVENT_KINDS } from "./parent-rule.js";
import { startPassLoop } from "./pass-loop.js";
import { postTaskEvent } from "./task-posts.js";
import type { SlackApi } from "./web-api.js";

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

/** What one event's posts came to. A retry ends the pass; the event is tried again next pass. */
export type EventOutcome = { kind: "done"; posted: number } | { kind: "retry"; reason: string; afterMs: number | null };

/**
 * What one pass did. `posted` counts every Slack write that succeeded (posts and edits); `retry`
 * is set when Slack or the network failed and the pass stopped.
 */
export interface OutboundPass {
  posted: number;
  retry: { reason: string; afterMs: number | null } | null;
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
    const page = await listEvents(o.db, { after, kinds: [...TASK_EVENT_KINDS, ...NEWS_EVENT_KINDS], limit: PAGE });
    for (const e of page.events) {
      const r = NEWS_EVENT_KINDS.includes(e.kind) ? await postNewsEvent(o, e) : await postTaskEvent(o, e);
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

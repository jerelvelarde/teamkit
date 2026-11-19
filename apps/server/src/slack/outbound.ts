import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { currentCursor, listEvents } from "../store/events.js";
import { loadTask } from "../store/task-load.js";
import { toSlackMessage } from "./blocks.js";
import { BlockedCard, OutcomeCard, type CardTask } from "./cards.js";
import {
  getServiceCursor,
  getSlackThread,
  nativeConversationKey,
  saveSlackThread,
  setServiceCursor,
  slackRoomSettings,
} from "./mirror.js";

const CURSOR_NAME = "slack-outbound";
const PAGE = 100;
const RETRY_BACKOFF_MS = [200, 800];
const DEFAULT_POLL_MS = 5000;

export interface OutboundOptions {
  db: Db;
  notifier: Notifier;
  slack: { token: string; apiBase?: string; fetch?: typeof fetch };
  publicUrl: string;
  pollMs?: number;
  log?: (line: string) => void;
}

type Message = { blocks: unknown[]; text: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * chat.postMessage with three attempts. The token only goes into the Authorization
 * header; log lines carry the HTTP status or Slack's error code, never the token.
 * Returns the new message's ts, or null once every attempt has failed.
 */
async function postMessage(
  o: OutboundOptions,
  body: { channel: string; thread_ts?: string } & Message,
): Promise<string | null> {
  const doFetch = o.slack.fetch ?? fetch;
  const url = `${o.slack.apiBase ?? "https://slack.com/api"}/chat.postMessage`;
  const attempts = RETRY_BACKOFF_MS.length + 1;
  let reason = "unknown";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(RETRY_BACKOFF_MS[i - 1] as number);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${o.slack.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
        if (json.ok === true && typeof json.ts === "string") return json.ts;
        reason = `slack error ${json.error ?? "unknown"}`;
      } else {
        reason = `http ${res.status}`;
      }
    } catch (err) {
      reason = `request failed (${err instanceof Error ? err.name : "error"})`;
    }
  }
  o.log?.(`slack-outbound: giving up on a post to ${body.channel} after ${attempts} attempts: ${reason}`);
  return null;
}

async function handleEvent(o: OutboundOptions, e: BoardEvent): Promise<number> {
  if (e.threadId === null) return 0;
  const taskId = e.threadId;
  const settings = await slackRoomSettings(o.db, e.room);
  if (settings.channel === null || settings.announce === "none") return 0;
  const mirror = await getSlackThread(o.db, taskId);
  const inThread = mirror?.channel != null && mirror.ts != null;

  const task = await loadTask(o.db, taskId);
  if (!task) return 0;
  const card: CardTask = {
    id: taskId,
    room: e.room,
    state: task.state,
    brief: task.brief,
    url: `${o.publicUrl.replace(/\/+$/, "")}/t/${taskId}`,
  };

  let message: Message;
  if (e.kind === "task.blocked") {
    const d = e.data as { interruptId?: string; kind?: string; question?: string; options?: string[] | null };
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

  if (inThread) {
    const ts = await postMessage(o, { channel: mirror.channel as string, thread_ts: mirror.ts as string, ...message });
    return ts === null ? 0 : 1;
  }
  const topLevel = e.kind === "task.blocked" || settings.announce === "all";
  if (!topLevel) return 0;
  const ts = await postMessage(o, { channel: settings.channel, ...message });
  if (ts === null) return 0;
  await saveSlackThread(o.db, {
    taskId,
    channel: settings.channel,
    ts,
    conversationKey: nativeConversationKey(settings.channel, ts),
  });
  return 1;
}

/**
 * One pass over events past the persisted "slack-outbound" cursor. Delivery is
 * at-least-once: the cursor moves after each event's post, so a crash between a
 * post and its cursor write repeats that one post on restart. Returns the number of
 * messages posted.
 */
export async function processOutboundOnce(o: OutboundOptions): Promise<number> {
  let after = await getServiceCursor(o.db, CURSOR_NAME);
  if (after === null) {
    // First run: start at the head; never replay history into Slack.
    await setServiceCursor(o.db, CURSOR_NAME, await currentCursor(o.db));
    return 0;
  }
  let posted = 0;
  for (;;) {
    const page = await listEvents(o.db, {
      after,
      kinds: ["task.blocked", "task.completed", "task.failed"],
      limit: PAGE,
    });
    for (const e of page.events) {
      posted += await handleEvent(o, e);
      await setServiceCursor(o.db, CURSOR_NAME, e.cursor);
    }
    if (page.events.length < PAGE) return posted;
    after = page.cursor;
  }
}

export async function startOutbound(o: OutboundOptions): Promise<{ stop(): Promise<void> }> {
  let stopped = false;
  let dirty = true;
  let running: Promise<void> | null = null;

  const pass = () => {
    if (running) {
      dirty = true;
      return;
    }
    running = (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          try {
            await processOutboundOnce(o);
          } catch (err) {
            o.log?.(`slack-outbound: pass failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        running = null;
      }
    })();
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
      await running;
    },
  };
}

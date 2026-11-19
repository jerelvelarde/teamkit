import type { BoardEvent, ChangeEntry, Task } from "@copilotkit/teamkit-protocol";
import { loadTask } from "../store/task-load.js";
import { toSlackMessage } from "./blocks.js";
import { BlockedCard, OutcomeCard, TaskCard, type CardTask } from "./cards.js";
import { entityIdOf, handoffTarget, loadChange } from "./coordination.js";
import {
  answeredLine,
  changeLoggedLine,
  changeUpdatedLine,
  claimedLine,
  handoffLine,
  progressLine,
} from "./lines.js";
import { getSlackThread, saveSlackThread, slackRoomSettings } from "./mirror.js";
import type { EventOutcome, OutboundOptions } from "./outbound.js";
import { placeTaskEvent } from "./parent-rule.js";
import { callSlack } from "./web-api.js";

type Message = { blocks?: unknown[]; text: string };

const SKIP: EventOutcome = { kind: "done", posted: 0 };

/** The text of an agent's reply: the joined deltas of its TEXT_MESSAGE_CONTENT events. */
function replyText(e: BoardEvent): string {
  return e.agui
    .filter((a) => a.type === "TEXT_MESSAGE_CONTENT")
    .map((a) => String((a as { delta?: unknown }).delta ?? ""))
    .join("");
}

/** The card or line one event posts. */
function render(o: OutboundOptions, e: BoardEvent, task: Task, change: ChangeEntry | null): Message {
  const card: CardTask = {
    id: task.id,
    room: task.room,
    state: task.state,
    brief: task.brief,
    url: `${o.publicUrl.replace(/\/+$/, "")}/t/${task.id}`,
  };
  const by = e.actor?.name ?? "someone";
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case "task.created":
      return toSlackMessage(TaskCard({ task: card }));
    case "task.blocked":
      return toSlackMessage(
        BlockedCard({
          task: card,
          interruptId: String(d.interruptId ?? ""),
          kind: d.kind === "awaiting_approval" ? "awaiting_approval" : "awaiting_input",
          question: String(d.question ?? ""),
          options: Array.isArray(d.options) ? (d.options as string[]) : [],
          askedBy: e.actor?.name ?? null,
        }),
      );
    case "task.completed":
      return toSlackMessage(OutcomeCard({ task: card, outcome: "completed", text: task.result ?? "" }));
    case "task.failed":
      return toSlackMessage(OutcomeCard({ task: card, outcome: "failed", text: String(d.reason ?? "") }));
    case "task.claimed":
      return { text: claimedLine(by) };
    case "task.answered":
      return { text: answeredLine(by, String(d.choice ?? d.text ?? "")) };
    case "task.handed_off": {
      const to = handoffTarget(e) ?? "another agent";
      const held =
        task.reservedFor?.name === to && task.reservedUntil
          ? Math.round((Date.parse(task.reservedUntil) - Date.parse(e.createdAt)) / 60_000)
          : null;
      return { text: handoffLine(by, to, held) };
    }
    case "message.posted":
      return { text: progressLine(by, replyText(e)) };
    case "change.logged":
      return { text: changeLoggedLine(change!) };
    case "change.updated":
      return { text: changeUpdatedLine(change!, by) };
    default:
      return { text: "" };
  }
}

/**
 * Posts what one task event calls for, by the parent rule (parent-rule.ts): a task gets a Slack
 * parent only when it first needs a person, or with announce "all", and its later events go in
 * that thread. A retry ends the pass and the event is tried again; a parent saved before the
 * retry is reused. A permanent refusal is logged once and the event skipped.
 */
export async function postTaskEvent(o: OutboundOptions, e: BoardEvent): Promise<EventOutcome> {
  const settings = await slackRoomSettings(o.db, e.room);
  if (settings.channel === null || settings.announce === "none") return SKIP;

  let change: ChangeEntry | null = null;
  let taskId: string | null = e.threadId;
  if (e.kind === "change.logged" || e.kind === "change.updated") {
    const id = entityIdOf(e);
    change = id ? await loadChange(o.db, id) : null;
    taskId = change?.threadId ?? null;
  }
  if (taskId === null) return SKIP;
  const task = await loadTask(o.db, taskId);
  if (!task) return SKIP; // a thread that is not a task
  if (e.kind === "message.posted" && (e.data as { role?: unknown }).role !== "assistant") return SKIP;
  if (e.kind === "task.blocked") {
    // A question that was answered (or replaced) since: its buttons could only fail, and after a
    // pause (a rate limit, a bad token) the stale ones would arrive as a flood.
    const interruptId = (e.data as { interruptId?: unknown }).interruptId;
    if (task.state !== "blocked" || task.block?.interruptId !== interruptId) return SKIP;
  }

  const mirror = await getSlackThread(o.db, taskId);
  const hasParent = mirror?.channel != null && mirror.ts != null;
  const placement = placeTaskEvent({ kind: e.kind, announce: settings.announce, hasParent });
  if (placement === "skip") return SKIP;
  const message = render(o, e, task, change);
  const dropped = (channel: string, reason: string): EventOutcome => {
    o.log?.(`slack-outbound: dropped the ${e.kind} post for task ${taskId} to ${channel}: ${reason}`);
    return SKIP;
  };

  /** Posts at the top level and saves the result as the task's parent. */
  const postParent = async (m: Message): Promise<{ ts: string } | EventOutcome> => {
    const channel = settings.channel!;
    const r = await callSlack(o.slack, "chat.postMessage", { channel, ...m });
    if (r.kind === "retry") return r;
    if (r.kind === "permanent") return dropped(channel, r.reason);
    if (r.ts === null) return dropped(channel, "slack error no_ts");
    // The conversation key is left for the first turn from the new thread to fill in; a key the
    // task already has, from the mention that created it, is kept.
    await saveSlackThread(o.db, { taskId: taskId!, channel, ts: r.ts, conversationKey: null });
    return { ts: r.ts };
  };
  const postInThread = async (channel: string, ts: string, m: Message, broadcast = false): Promise<EventOutcome> => {
    const r = await callSlack(o.slack, "chat.postMessage", { channel, thread_ts: ts, ...(broadcast ? { reply_broadcast: true } : {}), ...m });
    if (r.kind === "retry") return r;
    if (r.kind === "permanent") return dropped(channel, r.reason);
    return { kind: "done", posted: 1 };
  };

  switch (placement) {
    case "top": {
      const p = await postParent(message);
      return "ts" in p ? { kind: "done", posted: 1 } : p;
    }
    case "thread":
    case "thread-broadcast":
      return postInThread(mirror!.channel!, mirror!.ts!, message, placement === "thread-broadcast");
    case "parent-then-thread": {
      const card: CardTask = {
        id: task.id,
        room: task.room,
        state: task.state,
        brief: task.brief,
        url: `${o.publicUrl.replace(/\/+$/, "")}/t/${task.id}`,
      };
      const p = await postParent(toSlackMessage(TaskCard({ task: card })));
      if (!("ts" in p)) return p;
      const r = await postInThread(settings.channel!, p.ts, message);
      return r.kind === "done" ? { kind: "done", posted: 1 + r.posted } : r;
    }
  }
}

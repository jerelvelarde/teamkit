import { EVENT_KINDS } from "@copilotkit/teamkit-protocol";
import type { BoardEvent, EventKind } from "@copilotkit/teamkit-protocol";
import type { ActorView, ViewItem } from "./fold";

/**
 * What a room's log shows: every kind except run events, which stream an agent's tokens and
 * lifecycle, and label changes, which are bookkeeping. Both stay in the task's own thread.
 */
export const LOG_KINDS: EventKind[] = EVENT_KINDS.filter((k) => k !== "run.event" && k !== "label.set");

/** The log holds this many recent events; older ones drop off the top. */
export const LOG_LIMIT = 400;

/** The server's plain-text copy of a block's question. The question card already shows it. */
export const QUESTION_TEXT = /^Question \((needs_input|awaiting_approval)\): /;

export function keepRecent<T>(list: T[], n: number = LOG_LIMIT): T[] {
  return list.length > n ? list.slice(list.length - n) : list;
}

export interface LogItem {
  item: ViewItem;
  at: string | null;
}

export type LogRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; key: string; threadId: string | null; room: string; topic: string; items: LogItem[] };

/** What a group is about when its thread is not a task: named after the event that started it. */
export function topicOf(kind: string | undefined): string {
  if (kind?.startsWith("decision.")) return "Decision";
  if (kind?.startsWith("alert.")) return "Alert";
  if (kind?.startsWith("rollcall.")) return "Roll call";
  if (kind?.startsWith("change.")) return "Change";
  return "Conversation";
}

/** "Run started" follows every claim, so the log leaves it to the task's own thread. */
function redundant(item: ViewItem): boolean {
  return item.kind === "status" && item.label === "Run started";
}

/**
 * The brief a task opens with repeats the group's title. Drop it when its event already says the
 * task was created; otherwise it becomes that line, so a task's creation is never lost.
 */
function briefAsCreated(item: ViewItem, e: BoardEvent | undefined, created: Set<string>): ViewItem | null | undefined {
  if (item.kind !== "message" || e?.kind !== "task.created") return undefined;
  if (created.has(item.cursor)) return null;
  return { kind: "status", id: `created-${item.id}`, label: "Task created", tone: "info", detail: null, cursor: item.cursor };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const LONG_DAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });

/** "Today", "Yesterday", or "Wednesday, Nov 19", in the reader's own timezone. */
export function dayLabel(at: Date, now: Date): string {
  if (dayKey(at) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return "Yesterday";
  return LONG_DAY.format(at);
}

/** Status lines a task's thread reads without a subject ("Completed"); in the log they need one. */
const VERBS: Record<string, string> = {
  "Task created": "created the task",
  Completed: "completed the task",
  Released: "released the task",
  Failed: "marked the task failed",
};

export function withSubject(item: ViewItem, actor: BoardEvent["actor"]): ViewItem {
  if (item.kind !== "status" || !actor) return item;
  const verb = VERBS[item.label];
  return verb ? { ...item, label: `${actor.name} ${verb}` } : item;
}

/** Two messages in a row from one author fold together, as a chat does. */
export function sameAuthor(a: ViewItem | undefined, b: ViewItem): boolean {
  const name = (x: ActorView | null) => (x ? `${x.kind}:${x.name}` : "");
  return a?.kind === "message" && b.kind === "message" && a.role === b.role && name(a.actor) === name(b.actor);
}

/**
 * Lay the folded items out like a channel: a divider when the day changes, and a group each
 * time the activity moves to another task (or to the room itself), so a run of one task's
 * events reads under that task's name.
 */
export function buildLog(items: ViewItem[], events: Map<string, BoardEvent>, now: Date): LogRow[] {
  const rows: LogRow[] = [];
  let day = "";
  let group: Extract<LogRow, { kind: "group" }> | null = null;
  const created = new Set(items.filter((i) => i.kind === "status" && i.label === "Task created").map((i) => i.cursor));
  for (const raw of items) {
    if (raw.kind === "message" && QUESTION_TEXT.test(raw.text)) continue;
    if (redundant(raw)) continue;
    const e = events.get(raw.cursor);
    const swapped = briefAsCreated(raw, e, created);
    if (swapped === null) continue;
    const item = swapped ?? raw;
    const at = e?.createdAt ?? null;
    const when = at ? new Date(at) : null;
    if (when && !Number.isNaN(when.getTime()) && dayKey(when) !== day) {
      day = dayKey(when);
      rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(when, now) });
      group = null;
    }
    const threadId = e?.threadId ?? null;
    const room = e?.room ?? "";
    if (!group || group.threadId !== threadId || group.room !== room) {
      group = { kind: "group", key: `group-${item.id}`, threadId, room, topic: topicOf(e?.kind), items: [] };
      rows.push(group);
    }
    group.items.push({ item: withSubject(item, e?.actor ?? null), at });
  }
  return rows;
}

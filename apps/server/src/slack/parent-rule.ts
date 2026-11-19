import type { EventKind } from "@copilotkit/teamkit-protocol";
import type { SlackAnnounce } from "./mirror.js";

/**
 * Where a task event goes in Slack. `top`: a new top-level message that becomes the task's parent.
 * `thread`: a reply under the parent. `thread-broadcast`: a reply also shown in the channel.
 * `parent-then-thread`: a task card at the top first, then the reply under it.
 */
export type Placement = "skip" | "top" | "thread" | "thread-broadcast" | "parent-then-thread";

/** The board events that can post to a task's Slack thread. */
export const TASK_EVENT_KINDS: readonly EventKind[] = [
  "task.created",
  "task.claimed",
  "task.blocked",
  "task.answered",
  "task.handed_off",
  "task.completed",
  "task.failed",
  "message.posted",
  "change.logged",
  "change.updated",
];

/**
 * A task gets a Slack parent only when it first needs a person (an ask), or with announce "all".
 * After that, its events go in that thread. Announce "none" posts nothing.
 */
export function placeTaskEvent(i: { kind: EventKind; announce: SlackAnnounce; hasParent: boolean }): Placement {
  if (i.announce === "none") return "skip";
  if (i.kind === "task.blocked") return i.hasParent ? "thread-broadcast" : "top";
  if (i.kind === "task.created") return i.announce === "all" && !i.hasParent ? "top" : "skip";
  if (i.hasParent) return "thread";
  return i.announce === "all" ? "parent-then-thread" : "skip";
}

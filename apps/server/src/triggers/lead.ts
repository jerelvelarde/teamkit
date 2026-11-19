import {
  custom,
  newId,
  textMessage,
  type AguiEvent,
  type AguiMessage,
  type BoardEvent,
  type Task,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { agentAuthContext, type RegisteredAgent } from "../dispatch/registry.js";
import { runAgentLoop, type LoopOutcome } from "../dispatch/run-loop.js";
import { requirePerm } from "../store/actors.js";
import { appendEvent } from "../store/events.js";
import { appendMessage, messageFor } from "../store/rows.js";
import { loadTask } from "../store/task-load.js";
import { post } from "../store/threads.js";

const BRIEF_LINE_MAX = 120;
/** The most lead-thread messages one wake-up sends the agent. */
export const LEAD_HISTORY_MAX = 50;

/** The user message that wakes a room's lead agent for one board event. */
export function wakeText(e: BoardEvent, task: Task | null): string {
  if (!task) return `Event ${e.kind} in ${e.room}.`;
  const line = (task.brief.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, BRIEF_LINE_MAX);
  return `Task ${task.id} in ${e.room} is now ${String(e.data.state ?? task.state)}: ${line}. Read it with teamkit_read.`;
}

/** The agent's lead thread in the room, or null before its first wake-up there. */
export async function findLeadThread(q: Q, agent: RegisteredAgent, room: string): Promise<string | null> {
  const [r] = await q`select thread_id from lead_threads where room = ${room} and agent_id = ${agent.actor.id}`;
  return (r?.thread_id as string | undefined) ?? null;
}

/** The agent's lead thread in the room: the stored one while it exists, else a new one, recorded for (room, agent). */
export async function ensureLeadThread(db: Db, agent: RegisteredAgent, room: string): Promise<string> {
  const found = await findLeadThread(db, agent, room);
  if (found) return found;
  const { threadId } = await post(db, agentAuthContext(agent), {
    room,
    text: `Lead thread for ${agent.name} in ${room}. TeamKit posts wake-ups here.`,
  });
  // A concurrent first wake-up may win; the stored id is the one both use.
  await db`
    insert into lead_threads (room, agent_id, thread_id) values (${room}, ${agent.actor.id}, ${threadId})
    on conflict do nothing`;
  return (await findLeadThread(db, agent, room))!;
}

/**
 * The thread's last LEAD_HISTORY_MAX messages, less any tool results at the start: their
 * tool call fell outside the window, and a model refuses a tool result without its call.
 */
async function recentMessages(db: Db, threadId: string): Promise<AguiMessage[]> {
  const rows = await db`
    select message from messages where thread_id = ${threadId} order by seq desc limit ${LEAD_HISTORY_MAX}`;
  const recent = rows.map((r) => r.message as AguiMessage).reverse();
  const start = recent.findIndex((m) => m.role !== "tool");
  return start > 0 ? recent.slice(start) : recent;
}

/** A user turn on the lead thread, in the agent's name, followed by `markers` in its event. */
async function postToLeadThread(
  db: Db,
  agent: RegisteredAgent,
  room: string,
  threadId: string,
  triggerId: string,
  text: string,
  markers: AguiEvent[],
): Promise<void> {
  const messageId = newId("msg");
  await db.begin(async (tx) => {
    await appendMessage(tx, threadId, messageFor({ messageId, role: "user", text, actor: agent.actor }));
    await appendEvent(tx, {
      kind: "message.posted",
      room,
      threadId,
      actorId: agent.actor.id,
      agui: [...textMessage({ messageId, role: "user", text, actor: agent.actor }), ...markers],
      data: { threadId, messageId, role: "user", triggerId },
    });
  });
}

export interface WakeLeadOptions {
  agent: RegisteredAgent;
  room: string;
  event: BoardEvent;
  triggerId: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Posts the wake-up to the agent's lead thread in the room and runs the agent on that
 * thread's recent messages. A plain run: no claim is taken and no task state changes
 * unless the agent's own board tool calls change it.
 */
export async function wakeLead(db: Db, o: WakeLeadOptions): Promise<LoopOutcome> {
  const { agent, room, event, triggerId } = o;
  const auth = agentAuthContext(agent);
  await requirePerm(db, auth, room, "read");
  const threadId = await ensureLeadThread(db, agent, room);
  const task = event.threadId ? await loadTask(db, event.threadId) : null;
  await postToLeadThread(db, agent, room, threadId, triggerId, wakeText(event, task), [
    custom("teamkit.trigger.fired", { triggerId, cursor: event.cursor, kind: event.kind }),
  ]);
  return runAgentLoop({
    db,
    agent,
    auth,
    threadId,
    room,
    messages: await recentMessages(db, threadId),
    context: [
      {
        description: "TeamKit lead wake-up",
        value: JSON.stringify({ room, cursor: event.cursor, kind: event.kind, taskId: event.threadId }),
      },
    ],
    signal: o.signal,
    fetch: o.fetch,
  });
}

import { custom, newId, textMessage, type BoardEvent, type Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { agentAuthContext, type RegisteredAgent } from "../dispatch/registry.js";
import { runAgentLoop, type LoopOutcome } from "../dispatch/run-loop.js";
import { appendEvent } from "../store/events.js";
import { appendMessage, messageFor } from "../store/rows.js";
import { loadTask } from "../store/task-load.js";
import { getThread, post } from "../store/threads.js";

const BRIEF_LINE_MAX = 120;

/** The user message that wakes a room's lead agent for one board event. */
export function wakeText(e: BoardEvent, task: Task | null): string {
  if (!task) return `Event ${e.kind} in ${e.room}.`;
  const line = (task.brief.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, BRIEF_LINE_MAX);
  return `Task ${task.id} in ${e.room} is now ${String(e.data.state ?? task.state)}: ${line}. Read it with teamkit_read.`;
}

/** The room's lead thread: the stored one while it exists, else a new one, recorded on the room. */
export async function ensureLeadThread(db: Db, agent: RegisteredAgent, room: string): Promise<string> {
  const [found] = await db`
    select r.lead_thread_id as id from rooms r
    join threads t on t.id = r.lead_thread_id
    where r.name = ${room}`;
  if (found) return found.id as string;
  const { threadId } = await post(db, agentAuthContext(agent), {
    room,
    text: `Lead thread for ${room}. TeamKit posts wake-ups here.`,
  });
  // A concurrent first wake-up may win; the stored id is the one both use.
  await db`update rooms set lead_thread_id = ${threadId} where name = ${room} and lead_thread_id is null`;
  const [r] = await db`select lead_thread_id as id from rooms where name = ${room}`;
  return r!.id as string;
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
 * Posts the wake-up to the room's lead thread and runs the lead agent on it. A plain
 * run: no claim is taken and no task state changes unless the agent's own board tool
 * calls change it.
 */
export async function wakeLead(db: Db, o: WakeLeadOptions): Promise<LoopOutcome> {
  const { agent, room, event, triggerId } = o;
  const auth = agentAuthContext(agent);
  const threadId = await ensureLeadThread(db, agent, room);
  const task = event.threadId ? await loadTask(db, event.threadId) : null;
  const text = wakeText(event, task);
  const messageId = newId("msg");
  await db.begin(async (tx) => {
    await appendMessage(tx, threadId, messageFor({ messageId, role: "user", text, actor: agent.actor }));
    await appendEvent(tx, {
      kind: "message.posted",
      room,
      threadId,
      actorId: agent.actor.id,
      agui: [
        ...textMessage({ messageId, role: "user", text, actor: agent.actor }),
        custom("teamkit.trigger.fired", { triggerId, cursor: event.cursor, kind: event.kind }),
      ],
      data: { threadId, messageId, role: "user", triggerId },
    });
  });
  const messages = (await getThread(db, auth, threadId)).messages;
  return runAgentLoop({
    db,
    agent,
    auth,
    threadId,
    room,
    messages,
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

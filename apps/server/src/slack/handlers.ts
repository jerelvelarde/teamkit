import { isBoardError, newId, type ActorRef, type Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { TaskCard } from "./cards.js";
import { isNotAnswererError, refusalFor } from "./coordination.js";
import { findLinkedPerson } from "./links.js";
import {
  findTaskByConversation,
  findTaskByCoordinates,
  isUniqueViolation,
  roomForSlackChannel,
  saveSlackThread,
} from "./mirror.js";
import type { AuthContext } from "../store/actors.js";
import { answer } from "../store/blocks.js";
import { loadTask } from "../store/task-load.js";
import { createTask } from "../store/tasks.js";
import { reply } from "../store/threads.js";

export interface SlackThreadLike {
  conversationKey: string;
  post(ui: unknown): Promise<{ id: string }>;
  postEphemeral(user: { id: string } | string, ui: unknown, opts: { fallbackToDM: boolean }): Promise<unknown>;
}

export interface SlackTurn {
  thread: SlackThreadLike;
  text: string;
  slackUserId: string;
  slackUserName: string | null;
  coordinates: { channel: string; ts: string } | null;
}

export interface SlackHandlerDeps {
  db: Db;
  publicUrl: string;
  defaultRoom: string | null;
  guest: AuthContext;
}

const GUEST_NAME = "slack-guest";
const NATIVE_KEY_RE = /^([CDG][A-Z0-9]+)::(\d+\.\d+)$/;
export const NOT_MAPPED =
  "This Slack channel isn't mapped to a TeamKit room. An admin can run `teamkit rooms set <room> --slack-channel <channel id>`.";

/** The agent actor that acts for Slack users who have not linked a TeamKit account. No token. */
export async function ensureSlackGuest(db: Db): Promise<AuthContext> {
  const guest = (id: string): AuthContext => ({
    actor: { id, name: GUEST_NAME, kind: "agent" },
    via: "system",
    scope: "agent",
    role: null,
  });
  const find = async () => {
    const [r] = await db`select id from actors where name = ${GUEST_NAME} and kind = 'agent'`;
    return r ? (r.id as string) : null;
  };
  const existing = await find();
  if (existing) return guest(existing);
  const id = newId("ac");
  try {
    await db.begin(async (tx) => {
      await tx`insert into actors (id, kind, name) values (${id}, 'agent', ${GUEST_NAME})`;
      await tx`insert into grants (actor_id, room_pattern, perms) values (${id}, '*', ${["read", "post", "create"]})`;
    });
  } catch (e) {
    // A concurrent caller created it first.
    const raced = await find();
    if (raced) return guest(raced);
    throw e;
  }
  return guest(id);
}

function pickCoordinates(v: unknown): { channel: string; ts: string } | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const channel = o.channel;
  const ts = o.thread_ts ?? o.ts;
  if (typeof channel === "string" && channel !== "" && typeof ts === "string" && ts !== "") {
    return { channel, ts };
  }
  return null;
}

export function slackCoordinates(conversationKey: string, raw?: unknown): { channel: string; ts: string } | null {
  const m = NATIVE_KEY_RE.exec(conversationKey);
  if (m) return { channel: m[1]!, ts: m[2]! };
  const top = pickCoordinates(raw);
  if (top) return top;
  if (raw !== null && typeof raw === "object") return pickCoordinates((raw as { event?: unknown }).event);
  return null;
}

export function stripMention(text: string): string {
  return text.replace(/^(\s*<@[UW][A-Z0-9]+(\|[^>]*)?>)+/, "").trim();
}

async function actingAs(d: SlackHandlerDeps, slackUserId: string): Promise<{ auth: AuthContext; guest: boolean }> {
  const person = await findLinkedPerson(d.db, slackUserId);
  if (!person) return { auth: d.guest, guest: true };
  const actor: ActorRef = person.actor;
  return { auth: { actor, via: "session", scope: null, role: person.role }, guest: false };
}

function taskUrl(publicUrl: string, id: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/t/${id}`;
}

function who(t: SlackTurn): string {
  return t.slackUserName ?? t.slackUserId;
}

/**
 * The task a Slack thread mirrors: by its conversation key, else by its channel and ts (a thread
 * Slack outbound started, or one whose key the managed Channel reports differently).
 */
async function taskForThread(d: SlackHandlerDeps, t: SlackTurn): Promise<string | null> {
  const byKey = await findTaskByConversation(d.db, t.thread.conversationKey);
  if (byKey) return byKey;
  return t.coordinates ? findTaskByCoordinates(d.db, t.coordinates, t.thread.conversationKey) : null;
}

export function createSlackHandlers(d: SlackHandlerDeps): {
  onMention(t: SlackTurn): Promise<void>;
  onMessage(t: SlackTurn): Promise<void>;
} {
  async function mention(t: SlackTurn): Promise<void> {
    const text = stripMention(t.text);
    // A mention inside a thread that already mirrors a task is a message to that task.
    const existing = await taskForThread(d, t);
    if (existing) {
      await toTask(t, existing, text);
      return;
    }
    const room = (t.coordinates && (await roomForSlackChannel(d.db, t.coordinates.channel))) || d.defaultRoom;
    if (!room) {
      await t.thread.post(NOT_MAPPED);
      return;
    }
    if (text === "") {
      await t.thread.post("Mention me with what you need done.");
      return;
    }
    const { auth, guest } = await actingAs(d, t.slackUserId);
    const brief = guest ? `${text}\n\n(from Slack user ${who(t)})` : text;
    let task: Task;
    try {
      // The task and its mirror row commit together, so a lost race leaves no task behind.
      task = await createTask(
        d.db,
        auth,
        { room, brief, labels: { source: "slack" } },
        {
          alsoWrite: async (tx, taskId) => {
            await saveSlackThread(tx, {
              taskId,
              channel: t.coordinates?.channel ?? null,
              ts: t.coordinates?.ts ?? null,
              conversationKey: t.thread.conversationKey,
            });
          },
        },
      );
    } catch (e) {
      // Another mention in this thread created its task first: this one is a message to it.
      const winner = isUniqueViolation(e) ? await taskForThread(d, t) : null;
      if (!winner) throw e;
      await toTask(t, winner, text);
      return;
    }
    await t.thread.post(
      TaskCard({
        task: { id: task.id, room: task.room, state: task.state, brief: task.brief, url: taskUrl(d.publicUrl, task.id) },
      }),
    );
  }

  /**
   * Tries to answer a blocked task from a linked person's reply. True when it was handled.
   * needs_input takes an option in any case, or free text when it has no options. An approval
   * takes only an option's exact text: a casual "ok" or "yes" is a plain reply, and an approval
   * with no options is answered only with a button or on the board.
   */
  async function tryAnswer(t: SlackTurn, auth: AuthContext, task: Task, text: string): Promise<boolean> {
    const block = task.state === "blocked" ? task.block : null;
    if (!block) return false;
    let input: { choice: string } | { text: string };
    if (block.kind === "awaiting_approval") {
      const choice = block.options?.find((o) => o === text);
      if (choice === undefined) return false;
      input = { choice };
    } else if (block.options) {
      const choice = block.options.find((o) => o.toLowerCase() === text.toLowerCase());
      if (choice === undefined) return false;
      input = { choice };
    } else {
      input = { text };
    }
    try {
      await answer(d.db, auth, task.id, input, { expectedInterruptId: block.interruptId });
      return true;
    } catch (e) {
      if (isNotAnswererError(e)) {
        await t.thread.postEphemeral(t.slackUserId, await refusalFor(d.db, task.id), { fallbackToDM: false });
        return true;
      }
      // Someone else answered between the read and the write: treat this as a plain reply.
      if (isBoardError(e) && e.code === "invalid_state") return false;
      throw e;
    }
  }

  /** A Slack user's words go to the task as a "user" turn, never as the guest agent's own. */
  async function toTask(t: SlackTurn, taskId: string, text: string): Promise<void> {
    if (text === "") return;
    const { auth, guest } = await actingAs(d, t.slackUserId);
    if (!guest) {
      const task = await loadTask(d.db, taskId);
      if (task && (await tryAnswer(t, auth, task, text))) return;
    }
    await reply(d.db, auth, taskId, guest ? `${who(t)}: ${text}` : text, { asUser: true });
  }

  async function message(t: SlackTurn): Promise<void> {
    const taskId = await taskForThread(d, t);
    if (!taskId) return;
    await toTask(t, taskId, t.text.trim());
  }

  async function guarded(kind: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(`slack ${kind} handler failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  return {
    onMention: (t) => guarded("mention", () => mention(t)),
    onMessage: (t) => guarded("message", () => message(t)),
  };
}

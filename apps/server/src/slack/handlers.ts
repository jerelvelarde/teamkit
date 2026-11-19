import { isBoardError, newId, type ActorRef, type Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { TaskCard } from "./cards.js";
import { findLinkedPerson } from "./links.js";
import { findTaskByConversation, roomForSlackChannel, saveSlackThread } from "./mirror.js";
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
const NOT_MAPPED =
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

export function createSlackHandlers(d: SlackHandlerDeps): {
  onMention(t: SlackTurn): Promise<void>;
  onMessage(t: SlackTurn): Promise<void>;
} {
  async function mention(t: SlackTurn): Promise<void> {
    const room = (t.coordinates && (await roomForSlackChannel(d.db, t.coordinates.channel))) || d.defaultRoom;
    if (!room) {
      await t.thread.post(NOT_MAPPED);
      return;
    }
    const text = stripMention(t.text);
    if (text === "") {
      await t.thread.post("Mention me with what you need done.");
      return;
    }
    const { auth, guest } = await actingAs(d, t.slackUserId);
    const brief = guest ? `${text}\n\n(from Slack user ${who(t)})` : text;
    const task = await createTask(d.db, auth, { room, brief, labels: { source: "slack" } });
    await saveSlackThread(d.db, {
      taskId: task.id,
      channel: t.coordinates?.channel ?? null,
      ts: t.coordinates?.ts ?? null,
      conversationKey: t.thread.conversationKey,
    });
    await t.thread.post(
      TaskCard({
        task: { id: task.id, room: task.room, state: task.state, brief: task.brief, url: taskUrl(d.publicUrl, task.id) },
      }),
    );
  }

  /** Tries to answer a blocked task from a linked person's reply. True when it was handled. */
  async function tryAnswer(t: SlackTurn, auth: AuthContext, task: Task, text: string): Promise<boolean> {
    const block = task.state === "blocked" ? task.block : null;
    if (!block) return false;
    let input: { choice: string } | { text: string };
    if (block.options) {
      const choice = block.options.find((o) => o.toLowerCase() === text.toLowerCase());
      if (choice === undefined) return false;
      input = { choice };
    } else {
      input = { text };
    }
    try {
      await answer(d.db, auth, task.id, input);
      return true;
    } catch (e) {
      if (isBoardError(e) && e.code === "approval_requires_person") {
        await t.thread.postEphemeral(t.slackUserId, "Only a listed approver can answer this approval.", {
          fallbackToDM: false,
        });
        return true;
      }
      // Someone else answered between the read and the write: treat this as a plain reply.
      if (isBoardError(e) && e.code === "invalid_state") return false;
      throw e;
    }
  }

  async function message(t: SlackTurn): Promise<void> {
    const taskId = await findTaskByConversation(d.db, t.thread.conversationKey);
    if (!taskId) return;
    const text = t.text.trim();
    if (text === "") return;
    const { auth, guest } = await actingAs(d, t.slackUserId);
    if (!guest) {
      const task = await loadTask(d.db, taskId);
      if (task && (await tryAnswer(t, auth, task, text))) return;
    }
    await reply(d.db, auth, taskId, guest ? `${who(t)}: ${text}` : text);
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

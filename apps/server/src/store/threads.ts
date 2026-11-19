import {
  BoardError,
  custom,
  isValidRoom,
  newId,
  textMessage,
  type AguiMessage,
  type ThreadView,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { appendEvent } from "./events.js";
import {
  appendMessage,
  assertText,
  ensureRoom,
  insertThread,
  loadThreadInfo,
  messageFor,
  validateLabels,
} from "./rows.js";
import { loadTask } from "./task-load.js";

function roleOf(auth: AuthContext): "user" | "assistant" {
  return auth.actor.kind === "person" ? "user" : "assistant";
}

async function requireThread(q: Q, threadId: string) {
  const info = await loadThreadInfo(q, threadId);
  if (!info) throw new BoardError("not_found", `thread not found: ${String(threadId)}`);
  return info;
}

export async function post(
  db: Db,
  auth: AuthContext,
  input: { room: string; text: string },
): Promise<{ threadId: string }> {
  const { room } = input;
  if (typeof room !== "string" || !isValidRoom(room)) {
    throw new BoardError("invalid_input", `invalid room name "${String(room)}"`);
  }
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "post");
    const text = assertText("text", input.text, { required: true })!;
    await ensureRoom(tx, room);
    const threadId = newId("th");
    const messageId = newId("msg");
    const role = roleOf(auth);
    await insertThread(tx, { id: threadId, room, isTask: false, labels: {}, createdBy: auth.actor.id });
    await appendMessage(tx, threadId, messageFor({ messageId, role, text, actor: auth.actor }));
    await appendEvent(tx, {
      kind: "thread.created",
      room,
      threadId,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.thread.created", { threadId, room }),
        ...textMessage({ messageId, role, text, actor: auth.actor }),
      ],
      data: { threadId, messageId },
    });
    return { threadId };
  });
}

export async function reply(db: Db, auth: AuthContext, threadId: string, text: string): Promise<void> {
  await db.begin(async (tx) => {
    const thread = await requireThread(tx, threadId);
    await requirePerm(tx, auth, thread.room, "post");
    const body = assertText("text", text, { required: true })!;
    const messageId = newId("msg");
    const role = roleOf(auth);
    await appendMessage(tx, threadId, messageFor({ messageId, role, text: body, actor: auth.actor }));
    const agui = textMessage({ messageId, role, text: body, actor: auth.actor });
    if (auth.actor.kind === "person") agui.push(custom("teamkit.message.posted", { threadId, messageId }));
    await appendEvent(tx, {
      kind: "message.posted",
      room: thread.room,
      threadId,
      actorId: auth.actor.id,
      agui,
      data: { threadId, messageId, role },
    });
  });
}

export async function setLabel(
  db: Db,
  auth: AuthContext,
  threadId: string,
  key: string,
  value: string,
): Promise<void> {
  await db.begin(async (tx) => {
    const thread = await requireThread(tx, threadId);
    await requirePerm(tx, auth, thread.room, "post");
    validateLabels({ [key]: value });
    await tx`update threads set labels = labels || jsonb_build_object(${key}::text, ${value}::text)
      where id = ${threadId}`;
    await appendEvent(tx, {
      kind: "label.set",
      room: thread.room,
      threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.label", { key, value })],
      data: { threadId, key, value },
    });
  });
}

export async function getThread(db: Db, auth: AuthContext, threadId: string): Promise<ThreadView> {
  const thread = await requireThread(db, threadId);
  await requirePerm(db, auth, thread.room, "read");
  const task = thread.isTask ? await loadTask(db, threadId) : null;
  const rows = await db`select message from messages where thread_id = ${threadId} order by seq`;
  const [c] = await db`select coalesce(max(cursor), 0)::text as cursor from events where thread_id = ${threadId}`;
  return {
    thread,
    task,
    messages: rows.map((r) => r.message as AguiMessage),
    cursor: c!.cursor as string,
  };
}

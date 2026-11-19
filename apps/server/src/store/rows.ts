import {
  BoardError,
  MAX_TEXT_LENGTH,
  isValidRoom,
  type ActorRef,
  type AguiMessage,
  type ThreadInfo,
} from "@copilotkit/teamkit-protocol";
import type { Q, Tx } from "../db/pool.js";

// A lone high surrogate (not followed by a low one) or a lone low surrogate (not preceded by a high one).
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Throws invalid_input if `value` holds a NUL or an unpaired UTF-16 surrogate.
 * Postgres text and jsonb cannot store NUL, jsonb rejects a lone surrogate
 * escape, and a text parameter would silently turn one into U+FFFD.
 */
export function assertCleanString(field: string, value: string): void {
  if (value.includes("\u0000")) throw new BoardError("invalid_input", `${field} must not contain NUL characters`);
  if (UNPAIRED_SURROGATE.test(value)) {
    throw new BoardError("invalid_input", `${field} must not contain unpaired surrogates`);
  }
}

export function assertText(field: string, value: unknown, opts?: { required?: boolean }): string | undefined {
  if (value === undefined || value === null) {
    if (opts?.required) throw new BoardError("invalid_input", `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new BoardError("invalid_input", `${field} must be a string`);
  if (value.length > MAX_TEXT_LENGTH) {
    throw new BoardError("invalid_input", `${field} exceeds ${MAX_TEXT_LENGTH} characters`);
  }
  assertCleanString(field, value);
  if (opts?.required && value.length === 0) throw new BoardError("invalid_input", `${field} is required`);
  return value;
}

const LABEL_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardError("invalid_input", "labels must be an object");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new BoardError("invalid_input", "labels must be a plain object");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!LABEL_KEY.test(k)) throw new BoardError("invalid_input", `invalid label key "${k}"`);
    if (typeof v !== "string") throw new BoardError("invalid_input", `label "${k}" must be a string`);
    if (v.length > 1000) throw new BoardError("invalid_input", `label "${k}" exceeds 1000 characters`);
    assertCleanString(`label "${k}"`, v);
    out[k] = v;
  }
  return out;
}

export async function ensureRoom(q: Q, name: string): Promise<void> {
  if (typeof name !== "string" || !isValidRoom(name)) {
    throw new BoardError("invalid_input", `invalid room name "${String(name)}"`);
  }
  await q`insert into rooms (name) values (${name}) on conflict do nothing`;
}

export async function insertThread(
  q: Q,
  t: { id: string; room: string; isTask: boolean; labels: Record<string, string>; createdBy: string },
): Promise<void> {
  await q`insert into threads (id, room, is_task, labels, created_by)
    values (${t.id}, ${t.room}, ${t.isTask}, ${q.json(t.labels)}, ${t.createdBy})`;
}

export function messageFor(m: {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  actor: ActorRef;
}): AguiMessage {
  return {
    id: m.messageId,
    role: m.role,
    content: m.text,
    name: m.actor.name,
    metadata: { teamkit: { actorId: m.actor.id, actorName: m.actor.name, actorKind: m.actor.kind } },
  } as AguiMessage;
}

/**
 * Appends a message with the thread's next seq. Takes a transaction: the thread
 * row lock that serializes seq allocation only lasts until the transaction ends.
 */
export async function appendMessage(tx: Tx, threadId: string, message: AguiMessage): Promise<number> {
  await tx`select id from threads where id = ${threadId} for update`;
  const [row] = await tx`
    insert into messages (thread_id, seq, message)
    select ${threadId}, coalesce(max(seq), 0) + 1, ${tx.json(message as never)}
    from messages where thread_id = ${threadId}
    returning seq`;
  return row!.seq as number;
}

export async function loadThreadInfo(q: Q, threadId: string): Promise<ThreadInfo | null> {
  const [r] = await q`
    select t.id, t.room, t.is_task, t.labels, t.created_at,
           a.id as actor_id, a.name as actor_name, a.kind as actor_kind
    from threads t join actors a on a.id = t.created_by
    where t.id = ${threadId}`;
  if (!r) return null;
  return {
    id: r.id as string,
    room: r.room as string,
    isTask: r.is_task as boolean,
    labels: r.labels as Record<string, string>,
    createdBy: { id: r.actor_id as string, name: r.actor_name as string, kind: r.actor_kind as "agent" | "person" },
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

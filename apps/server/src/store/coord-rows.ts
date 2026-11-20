import { BoardError, isValidRoom, newId, textMessage, type ActorRef, type AguiEvent } from "@copilotkit/teamkit-protocol";
import type { Q, Tx } from "../db/pool.js";
import type { AuthContext } from "./actors.js";
import { appendMessage, assertText, ensureRoom, insertThread, messageFor } from "./rows.js";

export const MAX_STATUS_LENGTH = 200;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

/** assertText with a length cap; `required` means it must be non-empty. */
export function assertShort(field: string, value: unknown, max: number, opts?: { required?: boolean }): string | undefined {
  const s = assertText(field, value, opts);
  if (s !== undefined && s.length > max) throw new BoardError("invalid_input", `${field} must be at most ${max} characters`);
  return s;
}

export function assertRoomName(room: unknown): string {
  if (typeof room !== "string" || !isValidRoom(room)) throw new BoardError("invalid_input", `invalid room name "${String(room)}"`);
  return room;
}

/** A list's size: 200 when unset, else a whole number from 1 to 1000. */
export function listLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new BoardError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

/**
 * A new non-task thread in `room` whose first message is `text`, written as the caller (a
 * person's message is a user turn, an agent's an assistant turn). Returns the AG-UI events to
 * log after the item's own CUSTOM event.
 */
export async function openItemThread(
  tx: Tx,
  auth: AuthContext,
  room: string,
  text: string,
): Promise<{ threadId: string; messageId: string; agui: AguiEvent[] }> {
  await ensureRoom(tx, room);
  const threadId = newId("th");
  const messageId = newId("msg");
  const role = auth.actor.kind === "person" ? "user" : "assistant";
  await insertThread(tx, { id: threadId, room, isTask: false, labels: {}, createdBy: auth.actor.id });
  await appendMessage(tx, threadId, messageFor({ messageId, role, text, actor: auth.actor }));
  return { threadId, messageId, agui: textMessage({ messageId, role, text, actor: auth.actor }) };
}

/** The agent's owner when it is a person, else null. */
export async function ownerOf(q: Q, agentId: string): Promise<ActorRef | null> {
  const [o] = await q`
    select o.id, o.name, o.kind from actors a join actors o on o.id = a.owner_id where a.id = ${agentId}`;
  return o && o.kind === "person" ? { id: o.id as string, name: o.name as string, kind: "person" } : null;
}

/**
 * Who the caller acts for. A person acts for themselves (`named`, when given, must be their own
 * name). An agent acts only for its owner, who must be a person, and must name them.
 */
export async function onBehalfOf(q: Q, auth: AuthContext, named: string | undefined, doing: string): Promise<ActorRef> {
  if (auth.actor.kind === "person") {
    if (named !== undefined && named !== auth.actor.name) {
      throw new BoardError("invalid_input", `${auth.actor.name} can only ${doing} for themselves`);
    }
    return auth.actor;
  }
  const owner = await ownerOf(q, auth.actor.id);
  if (!owner) throw new BoardError("forbidden", `${auth.actor.name} has no owner who is a person, so it cannot ${doing}`);
  if (named === undefined) throw new BoardError("invalid_input", `${auth.actor.name} must name its owner ${owner.name}`);
  if (named !== owner.name) throw new BoardError("forbidden", `${auth.actor.name} can only ${doing} for its owner ${owner.name}`);
  return owner;
}

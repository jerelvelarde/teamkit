import {
  BoardError,
  EVENT_KINDS,
  isValidRoomPattern,
  type ActorRef,
  type BoardEvent,
  type EventQuery,
} from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { can, requirePerm, type AuthContext } from "./actors.js";
import { listEvents } from "./events.js";
import { loadThreadInfo } from "./rows.js";

const KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const MAX_CURSOR = 9_223_372_036_854_775_807n; // bigint upper bound; larger values would fail in SQL

/** Throws invalid_input for a malformed query; returns it unchanged otherwise. */
export function validateEventQuery(q: EventQuery): EventQuery {
  if (q.after !== undefined) {
    if (typeof q.after !== "string" || !/^\d+$/.test(q.after) || BigInt(q.after) > MAX_CURSOR) {
      throw new BoardError("invalid_input", `invalid after cursor: ${String(q.after)}`);
    }
  }
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000) {
      throw new BoardError("invalid_input", "limit must be an integer from 1 to 1000");
    }
  }
  if (q.kinds !== undefined) {
    if (!Array.isArray(q.kinds)) throw new BoardError("invalid_input", "kinds must be an array");
    for (const k of q.kinds) {
      if (!KIND_SET.has(k)) throw new BoardError("invalid_input", `unknown event kind: ${String(k)}`);
    }
  }
  if (q.room !== undefined) {
    if (typeof q.room !== "string" || !isValidRoomPattern(q.room)) {
      throw new BoardError("invalid_input", `invalid room: ${String(q.room)}`);
    }
  }
  return q;
}

/**
 * Reads events the caller may see. Permission is checked up front for an explicit
 * thread or room; for a wildcard read by a non-person, events in rooms they cannot
 * read are dropped. The returned cursor is listEvents' cursor, so a reader never
 * stalls on a page of hidden events.
 */
export async function readEvents(
  db: Db,
  auth: AuthContext,
  q: EventQuery,
): Promise<{ events: BoardEvent[]; cursor: string }> {
  validateEventQuery(q);
  if (q.thread !== undefined) {
    const thread = await loadThreadInfo(db, q.thread);
    if (!thread) throw new BoardError("not_found", `thread not found: ${q.thread}`);
    await requirePerm(db, auth, thread.room, "read");
  }
  if (q.room !== undefined && q.room !== "*") {
    const base = q.room.endsWith("/") ? q.room.slice(0, -1) : q.room;
    await requirePerm(db, auth, base, "read");
  }
  const page = await listEvents(db, {
    after: q.after,
    room: q.room,
    threadId: q.thread,
    kinds: q.kinds,
    limit: q.limit,
  });
  if (auth.actor.kind === "person") return page;
  const allowed = new Map<string, boolean>();
  const readable = async (actor: ActorRef, room: string): Promise<boolean> => {
    let ok = allowed.get(room);
    if (ok === undefined) {
      ok = await can(db, actor, room, "read");
      allowed.set(room, ok);
    }
    return ok;
  };
  const events: BoardEvent[] = [];
  for (const e of page.events) {
    if (await readable(auth.actor, e.room)) events.push(e);
  }
  return { events, cursor: page.cursor };
}

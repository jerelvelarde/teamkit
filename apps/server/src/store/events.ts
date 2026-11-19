import type postgres from "postgres";
import type { ActorRef, AguiEvent, BoardEvent, EventKind } from "@copilotkit/teamkit-protocol";
import type { Q, Tx } from "../db/pool.js";

/** NOTIFY channel; the payload is the new event's cursor as decimal text. */
export const EVENTS_CHANNEL = "teamkit_events";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export interface AppendEventInput {
  kind: EventKind;
  room: string;
  threadId: string | null;
  actorId: string | null;
  agui: AguiEvent[];
  data?: Record<string, unknown>;
}

export interface ListEventsQuery {
  after?: string;
  room?: string;
  threadId?: string;
  kinds?: EventKind[];
  limit?: number;
}

interface EventRow {
  cursor: string;
  kind: EventKind;
  room: string;
  thread_id: string | null;
  agui: AguiEvent[];
  data: Record<string, unknown>;
  created_at: Date;
  actor_ref_id: string | null;
  actor_name: string | null;
  actor_kind: ActorRef["kind"] | null;
}

function toBoardEvent(row: EventRow): BoardEvent {
  const actor: ActorRef | null =
    row.actor_ref_id === null
      ? null
      : { id: row.actor_ref_id, name: row.actor_name as string, kind: row.actor_kind as ActorRef["kind"] };
  return {
    cursor: row.cursor,
    kind: row.kind,
    room: row.room,
    threadId: row.thread_id,
    actor,
    agui: row.agui,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Appends one event to the board's ordered log and returns it.
 *
 * Rule for every store module: take all row locks and do all inserts and updates
 * first, and call appendEvent LAST in the transaction. appendEvent takes
 * `pg_advisory_xact_lock(7731)`, which every append holds until its transaction
 * ends. The lock is re-entrant within one transaction, so several appends in one
 * transaction are fine; but a transaction that takes it and then waits for a row
 * lock can deadlock with one that holds that row and waits for this lock.
 *
 * Why the lock: the cursor comes from a sequence, and sequence values are handed
 * out when the insert runs, not when the transaction commits. Taking the lock
 * before the insert means a later cursor is only allocated after the earlier
 * transaction has committed or rolled back, so cursors become visible in order and
 * a reader following `after=<cursor>` never skips an event that commits late.
 *
 * Must be called inside a transaction; the NOTIFY is delivered on commit.
 */
export async function appendEvent(tx: Tx, e: AppendEventInput): Promise<BoardEvent> {
  await tx`select pg_advisory_xact_lock(7731)`;
  const [row] = await tx<EventRow[]>`
    with ins as (
      insert into events (kind, room, thread_id, actor_id, agui, data)
      values (
        ${e.kind},
        ${e.room},
        ${e.threadId},
        ${e.actorId},
        ${tx.json(e.agui as unknown as postgres.JSONValue)},
        ${tx.json((e.data ?? {}) as postgres.JSONValue)}
      )
      returning *
    )
    select ins.cursor::text as cursor, ins.kind, ins.room, ins.thread_id, ins.agui, ins.data, ins.created_at,
           a.id as actor_ref_id, a.name as actor_name, a.kind as actor_kind
    from ins left join actors a on a.id = ins.actor_id`;
  if (!row) throw new Error("appendEvent: insert returned no row");
  await tx`select pg_notify(${EVENTS_CHANNEL}, ${row.cursor})`;
  return toBoardEvent(row);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** "*" or undefined: no filter. "x/": room x and everything under it. Else: exact. */
function roomFilter(q: Q, room: string | undefined) {
  if (room === undefined || room === "*") return q``;
  if (room.endsWith("/")) {
    const base = room.slice(0, -1);
    return q`and (e.room = ${base} or e.room like ${`${escapeLike(base)}/%`})`;
  }
  return q`and e.room = ${room}`;
}

/**
 * Events after `after`, ascending by cursor. The returned cursor is the last
 * event's cursor, else `after`, else the current head of the log; pass it back as
 * `after` to continue without gaps. An empty `kinds` list means no kind filter.
 */
export async function listEvents(
  q: Q,
  query: ListEventsQuery,
): Promise<{ events: BoardEvent[]; cursor: string }> {
  const limit = clampLimit(query.limit);
  // Read the head BEFORE the page. Read afterwards, an event matching the filters
  // could commit between the two statements and the reader would skip past it.
  const head = query.after === undefined ? await currentCursor(q) : undefined;
  const rows = await q<EventRow[]>`
    select e.cursor::text as cursor, e.kind, e.room, e.thread_id, e.agui, e.data, e.created_at,
           a.id as actor_ref_id, a.name as actor_name, a.kind as actor_kind
    from events e
    left join actors a on a.id = e.actor_id
    where true
      ${query.after !== undefined ? q`and e.cursor > ${query.after}::bigint` : q``}
      ${roomFilter(q, query.room)}
      ${query.threadId !== undefined ? q`and e.thread_id = ${query.threadId}` : q``}
      ${query.kinds !== undefined && query.kinds.length > 0 ? q`and e.kind = any(${q.array(query.kinds)}::text[])` : q``}
    order by e.cursor asc
    limit ${limit}`;
  const events = rows.map(toBoardEvent);
  const last = events.at(-1);
  return { events, cursor: last ? last.cursor : (query.after ?? (head as string)) };
}

/** The highest committed cursor as decimal text, or "0" when the log is empty. */
export async function currentCursor(q: Q): Promise<string> {
  const [row] = await q<{ cursor: string }[]>`select coalesce(max(cursor), 0)::text as cursor from events`;
  if (!row) throw new Error("currentCursor: query returned no row");
  return row.cursor;
}

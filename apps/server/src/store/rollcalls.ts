import {
  BoardError,
  ID_PREFIXES,
  custom,
  newId,
  textMessage,
  type ActorRef,
  type RollCall,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { MAX_STATUS_LENGTH, assertRoomName, assertShort, listLimit, openItemThread } from "./coord-rows.js";
import { appendEvent } from "./events.js";
import { appendMessage, messageFor } from "./rows.js";

const ref = (id: unknown, name: unknown, kind: unknown): ActorRef => ({
  id: id as string,
  name: name as string,
  kind: kind as ActorRef["kind"],
});

/** Roll calls by id, each with its answers oldest first, in the order of `ids`. */
export async function loadRollCalls(q: Q, ids: string[]): Promise<RollCall[]> {
  if (ids.length === 0) return [];
  const rows = await q`
    select r.id, r.room, r.thread_id, r.created_at, a.id as a_id, a.name as a_name, a.kind as a_kind
    from rollcalls r join actors a on a.id = r.asked_by
    where r.id = any(${ids})`;
  const answers = await q`
    select x.rollcall_id, x.status, x.at, a.id, a.name, a.kind
    from rollcall_answers x join actors a on a.id = x.actor_id
    where x.rollcall_id = any(${ids})
    order by x.at, a.name`;
  const byId = new Map<string, RollCall>();
  for (const r of rows) {
    byId.set(r.id as string, {
      id: r.id as string,
      room: r.room as string,
      threadId: r.thread_id as string,
      askedBy: ref(r.a_id, r.a_name, r.a_kind),
      createdAt: (r.created_at as Date).toISOString(),
      answers: [],
    });
  }
  for (const x of answers) {
    byId.get(x.rollcall_id as string)?.answers.push({
      actor: ref(x.id, x.name, x.kind),
      status: x.status as string,
      at: (x.at as Date).toISOString(),
    });
  }
  return ids.map((id) => byId.get(id)).filter((r): r is RollCall => r !== undefined);
}

/** Asks who is on in the room, on a new thread. */
export async function startRollCall(db: Db, auth: AuthContext, room: string): Promise<RollCall> {
  assertRoomName(room);
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "post");
    const thread = await openItemThread(tx, auth, room, `Roll call: who is on in ${room}?`);
    const rollCallId = newId(ID_PREFIXES.rollCall);
    await tx`insert into rollcalls (id, room, thread_id, asked_by) values (${rollCallId}, ${room}, ${thread.threadId}, ${auth.actor.id})`;
    await appendEvent(tx, {
      kind: "rollcall.started",
      room,
      threadId: thread.threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.rollcall.started", { rollCallId, room, askedBy: auth.actor }), ...thread.agui],
      data: { rollCallId, messageId: thread.messageId },
    });
    return (await loadRollCalls(tx, [rollCallId]))[0]!;
  });
}

/** Answers a roll call. A later answer replaces the earlier one; answers are accepted at any age. */
export async function answerRollCall(db: Db, auth: AuthContext, id: string, status: string): Promise<RollCall> {
  const text = assertShort("status", status, MAX_STATUS_LENGTH, { required: true })!;
  return db.begin(async (tx) => {
    const [r] = await tx`select id, room, thread_id from rollcalls where id = ${id}`;
    if (!r) throw new BoardError("not_found", `roll call ${id} not found`);
    await requirePerm(tx, auth, r.room as string, "post");
    await tx`
      insert into rollcall_answers (rollcall_id, actor_id, status) values (${id}, ${auth.actor.id}, ${text})
      on conflict (rollcall_id, actor_id) do update set status = excluded.status, at = clock_timestamp()`;
    const messageId = newId(ID_PREFIXES.message);
    const role = auth.actor.kind === "person" ? "user" : "assistant";
    await appendMessage(tx, r.thread_id as string, messageFor({ messageId, role, text, actor: auth.actor }));
    await appendEvent(tx, {
      kind: "rollcall.answered",
      room: r.room as string,
      threadId: r.thread_id as string,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.rollcall.answered", { rollCallId: id, by: auth.actor, status: text }),
        ...textMessage({ messageId, role, text, actor: auth.actor }),
      ],
      data: { rollCallId: id, status: text, messageId },
    });
    return (await loadRollCalls(tx, [id]))[0]!;
  });
}

/** The room's roll calls, newest first. */
export async function listRollCalls(db: Db, auth: AuthContext, room: string, opts?: { limit?: number }): Promise<RollCall[]> {
  const limit = listLimit(opts?.limit);
  assertRoomName(room);
  await requirePerm(db, auth, room, "read");
  const rows = await db`select id from rollcalls where room = ${room} order by created_at desc, id desc limit ${limit}`;
  return loadRollCalls(db, rows.map((r) => r.id as string));
}

import { BoardError, ID_PREFIXES, custom, newId, type ActorRef, type Decision } from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { assertRoomName, assertShort, listLimit, onBehalfOf, openItemThread } from "./coord-rows.js";
import { appendEvent } from "./events.js";

const MAX_DECISION_LENGTH = 2000;

type ActorRow = { id: string; name: string; kind: "agent" | "person" };
const ref = (id: unknown, name: unknown, kind: unknown): ActorRef => ({
  id: id as string,
  name: name as string,
  kind: kind as ActorRow["kind"],
});

/** Decisions by id, each with its acks oldest first, in the order of `ids`. */
export async function loadDecisions(q: Q, ids: string[]): Promise<Decision[]> {
  if (ids.length === 0) return [];
  const rows = await q`
    select d.id, d.room, d.thread_id, d.text, d.created_at,
           db.id as db_id, db.name as db_name, db.kind as db_kind,
           pb.id as pb_id, pb.name as pb_name, pb.kind as pb_kind
    from decisions d
    join actors db on db.id = d.decided_by
    join actors pb on pb.id = d.posted_by
    where d.id = any(${ids})`;
  const acks = await q`
    select k.decision_id, k.at, a.id, a.name, a.kind
    from decision_acks k join actors a on a.id = k.actor_id
    where k.decision_id = any(${ids})
    order by k.at, a.name`;
  const byId = new Map<string, Decision>();
  for (const r of rows) {
    byId.set(r.id as string, {
      id: r.id as string,
      room: r.room as string,
      threadId: r.thread_id as string,
      text: r.text as string,
      decidedBy: ref(r.db_id, r.db_name, r.db_kind),
      postedBy: ref(r.pb_id, r.pb_name, r.pb_kind),
      createdAt: (r.created_at as Date).toISOString(),
      acks: [],
    });
  }
  for (const k of acks) {
    byId.get(k.decision_id as string)?.acks.push({ actor: ref(k.id, k.name, k.kind), at: (k.at as Date).toISOString() });
  }
  return ids.map((id) => byId.get(id)).filter((d): d is Decision => d !== undefined);
}

/** Posts a decision a person made. An agent posts one only for its owner, naming them as the decider. */
export async function postDecision(
  db: Db,
  auth: AuthContext,
  input: { room: string; text: string; decidedBy?: string },
): Promise<Decision> {
  const room = assertRoomName(input.room);
  const text = assertShort("text", input.text, MAX_DECISION_LENGTH, { required: true })!;
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "post");
    const decidedBy = await onBehalfOf(tx, auth, input.decidedBy, "post a decision");
    const thread = await openItemThread(tx, auth, room, `Decision by ${decidedBy.name}: ${text}`);
    const decisionId = newId(ID_PREFIXES.decision);
    await tx`
      insert into decisions (id, room, thread_id, text, decided_by, posted_by)
      values (${decisionId}, ${room}, ${thread.threadId}, ${text}, ${decidedBy.id}, ${auth.actor.id})`;
    await appendEvent(tx, {
      kind: "decision.posted",
      room,
      threadId: thread.threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.decision.posted", { decisionId, room, text, decidedBy, postedBy: auth.actor }), ...thread.agui],
      data: { decisionId, decidedBy, messageId: thread.messageId },
    });
    return (await loadDecisions(tx, [decisionId]))[0]!;
  });
}

/** Records that the caller read the decision. Acking twice records it once; an ack blocks nothing. */
export async function ackDecision(db: Db, auth: AuthContext, id: string): Promise<Decision> {
  return db.begin(async (tx) => {
    const [d] = await tx`select id, room, thread_id from decisions where id = ${id}`;
    if (!d) throw new BoardError("not_found", `decision ${id} not found`);
    await requirePerm(tx, auth, d.room as string, "read");
    const added = await tx`
      insert into decision_acks (decision_id, actor_id) values (${id}, ${auth.actor.id})
      on conflict do nothing returning decision_id`;
    if (added.length > 0) {
      await appendEvent(tx, {
        kind: "decision.acked",
        room: d.room as string,
        threadId: d.thread_id as string,
        actorId: auth.actor.id,
        agui: [custom("teamkit.decision.acked", { decisionId: id, by: auth.actor })],
        data: { decisionId: id },
      });
    }
    return (await loadDecisions(tx, [id]))[0]!;
  });
}

/** The room's decisions, newest first. */
export async function listDecisions(
  db: Db,
  auth: AuthContext,
  room: string,
  opts?: { limit?: number },
): Promise<Decision[]> {
  const limit = listLimit(opts?.limit);
  assertRoomName(room);
  await requirePerm(db, auth, room, "read");
  const rows = await db`select id from decisions where room = ${room} order by created_at desc, id desc limit ${limit}`;
  return loadDecisions(db, rows.map((r) => r.id as string));
}

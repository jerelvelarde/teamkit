import { custom, type ActorRef } from "@copilotkit/teamkit-protocol";
import type { Db, Tx } from "../db/pool.js";
import { appendEvent } from "./events.js";

export type ReservationKind = "handoff" | "answer";

/**
 * Holds the task for `actorId` until now() plus its room's reservation_minutes and returns
 * reservedUntil (ISO). A row write only: call it before the transaction's appendEvent.
 */
export async function reserve(tx: Tx, taskId: string, actorId: string, kind: ReservationKind): Promise<string> {
  const [r] = await tx`
    update tasks t
    set reserved_for = ${actorId}, reservation_kind = ${kind},
        reserved_until = now() + (
          select ro.reservation_minutes from threads th join rooms ro on ro.name = th.room where th.id = t.thread_id
        ) * interval '1 minute'
    where t.thread_id = ${taskId}
    returning t.reserved_until`;
  if (!r) throw new Error(`reserve: task ${taskId} vanished`);
  return (r.reserved_until as Date).toISOString();
}

interface LapsedRow {
  thread_id: string;
  room: string;
  state: string;
  holder_id: string;
  holder_name: string;
  holder_kind: "agent" | "person";
}

/**
 * Clears holds that ended before `now` and logs one task.ready per task (reason
 * reservation_lapsed), so a claim-next poll waiting on the room wakes. Rows locked by another
 * transaction are skipped and picked up next time. Returns how many holds lapsed.
 */
export async function lapseReservations(db: Db, now: Date = new Date()): Promise<number> {
  return db.begin(async (tx) => {
    const rows = await tx<LapsedRow[]>`
      with x as (
        select t.thread_id, t.reserved_for, t.state, th.room
        from tasks t join threads th on th.id = t.thread_id
        where t.reserved_until is not null and t.reserved_until < ${now}
        order by t.thread_id
        for update of t skip locked
      )
      update tasks t
      set reserved_for = null, reserved_until = null, reservation_kind = null
      from x join actors a on a.id = x.reserved_for
      where t.thread_id = x.thread_id
      returning x.thread_id, x.room, x.state, a.id as holder_id, a.name as holder_name, a.kind as holder_kind`;
    rows.sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0));
    for (const r of rows) {
      const reservedFor: ActorRef = { id: r.holder_id, name: r.holder_name, kind: r.holder_kind };
      await appendEvent(tx, {
        kind: "task.ready",
        room: r.room,
        threadId: r.thread_id,
        actorId: null,
        agui: [custom("teamkit.task.ready", { reason: "reservation_lapsed", reservedFor })],
        data: { taskId: r.thread_id, state: r.state, reason: "reservation_lapsed", reservedFor },
      });
    }
    return rows.length;
  });
}

import { ROLLCALL_OPEN_MS, roomMatches, type Pending } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import type { AuthContext } from "./actors.js";
import { loadDecisions } from "./decisions.js";
import { loadRollCalls } from "./rollcalls.js";
import { loadTasks } from "./task-load.js";

const MAX_ITEMS = 50;
const MAX_DECISIONS = 20;

/**
 * The rooms an agent can read, from its grants (the same match `can` uses), or null for a
 * person, who reads every room. Filtering in SQL keeps the caps honest: a cut taken before
 * the room check could drop readable rows for unreadable ones.
 */
async function readableRooms(db: Db, auth: AuthContext): Promise<string[] | null> {
  if (auth.actor.kind === "person") return null;
  const grants = await db`select room_pattern, perms from grants where actor_id = ${auth.actor.id}`;
  const rooms = await db`select name from rooms`;
  return rooms
    .map((r) => r.name as string)
    .filter((room) =>
      grants.some((g) => roomMatches(g.room_pattern as string, room) && (g.perms as string[]).includes("read")),
    );
}

/**
 * What is waiting on the caller: tasks held for it (handed off, or its question answered),
 * and, for an agent, decisions to acknowledge and open roll calls to answer; for a person,
 * the blocked tasks they may answer. An admin is not asked everything: the admin override
 * that lets them answer any approval is left out of `asks`.
 */
export async function pendingFor(db: Db, auth: AuthContext): Promise<Pending> {
  const me = auth.actor;
  const rooms = await readableRooms(db, auth);
  if (rooms !== null && rooms.length === 0) return { handoffs: [], answered: [], decisions: [], rollCalls: [], asks: [] };
  const inRooms = (col: ReturnType<typeof db.unsafe>) => (rooms === null ? db`` : db`and ${col} = any(${rooms})`);

  const held = async (kind: "handoff" | "answer") => {
    const rows = await db`
      select t.thread_id from tasks t join threads th on th.id = t.thread_id
      where t.state = 'ready' and t.reserved_for = ${me.id} and t.reservation_kind = ${kind}
        and t.reserved_until > now() ${inRooms(db.unsafe("th.room"))}
      order by t.reserved_until, t.thread_id limit ${MAX_ITEMS}`;
    return loadTasks(db, rows.map((r) => r.thread_id as string));
  };

  const handoffs = await held("handoff");
  const answered = await held("answer");
  if (me.kind === "person") {
    // The answer rule (blocks.ts answer), minus the admin override.
    const rows = await db`
      select t.thread_id from tasks t join threads th on th.id = t.thread_id left join rooms r on r.name = th.room
      where t.state = 'blocked' and t.block is not null and (
        case when coalesce(jsonb_typeof(t.block->'approvers'), 'null') = 'array'
          then t.block->'approvers' ? ${me.name}
          else t.block->>'kind' <> 'awaiting_approval'
            or r.approvers is null or cardinality(r.approvers) = 0 or ${me.name} = any(r.approvers)
        end)
      order by t.updated_at, t.thread_id limit ${MAX_ITEMS}`;
    const asks = await loadTasks(db, rows.map((r) => r.thread_id as string));
    return { handoffs, answered, decisions: [], rollCalls: [], asks };
  }

  const decisionRows = await db`
    select d.id from decisions d
    where d.posted_by <> ${me.id}
      and not exists (select 1 from decision_acks k where k.decision_id = d.id and k.actor_id = ${me.id})
      ${inRooms(db.unsafe("d.room"))}
    order by d.created_at desc, d.id desc limit ${MAX_DECISIONS}`;
  const rollCallRows = await db`
    select c.id from rollcalls c
    where c.created_at > now() - ${ROLLCALL_OPEN_MS}::int * interval '1 millisecond' and c.asked_by <> ${me.id}
      and not exists (select 1 from rollcall_answers a where a.rollcall_id = c.id and a.actor_id = ${me.id})
      ${inRooms(db.unsafe("c.room"))}
    order by c.created_at desc, c.id desc limit ${MAX_ITEMS}`;
  return {
    handoffs,
    answered,
    decisions: await loadDecisions(db, decisionRows.map((r) => r.id as string)),
    rollCalls: await loadRollCalls(db, rollCallRows.map((r) => r.id as string)),
    asks: [],
  };
}

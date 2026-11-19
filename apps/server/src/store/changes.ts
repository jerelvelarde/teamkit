import {
  BoardError,
  CHANGE_STATUSES,
  ID_PREFIXES,
  custom,
  newId,
  type ActorRef,
  type ChangeEntry,
  type ChangeInput,
  type ChangeStatus,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { assertRoomName, assertShort, listLimit, ownerOf } from "./coord-rows.js";
import { appendEvent } from "./events.js";

const MAX_WHAT = 500;
const MAX_WHERE = 200;
const ISO_START = /^\d{4}-\d\d-\d\dT/;

const ref = (id: unknown, name: unknown, kind: unknown): ActorRef => ({
  id: id as string,
  name: name as string,
  kind: kind as ActorRef["kind"],
});

function checkStatus(status: unknown): ChangeStatus {
  if (!(CHANGE_STATUSES as readonly unknown[]).includes(status)) {
    throw new BoardError("invalid_input", `status must be one of ${CHANGE_STATUSES.join(", ")}`);
  }
  return status as ChangeStatus;
}

/** Change-log entries by id, in the order of `ids`; unknown ids are skipped. */
export async function loadChanges(q: Q, ids: string[]): Promise<ChangeEntry[]> {
  if (ids.length === 0) return [];
  const rows = await q`
    select c.*, p.name as p_name, p.kind as p_kind, a.name as a_name, a.kind as a_kind
    from changes c join actors p on p.id = c.person_id left join actors a on a.id = c.agent_id
    where c.id = any(${ids})`;
  const byId = new Map<string, ChangeEntry>();
  for (const r of rows) {
    byId.set(r.id as string, {
      id: r.id as string,
      room: r.room as string,
      threadId: (r.thread_id as string | null) ?? null,
      what: r.what as string,
      where: r.where_text as string,
      at: (r.at as Date).toISOString(),
      person: ref(r.person_id, r.p_name, r.p_kind),
      agent: r.agent_id ? ref(r.agent_id, r.a_name, r.a_kind) : null,
      undo: r.undo as string,
      undoWhen: (r.undo_when as string | null) ?? null,
      status: r.status as ChangeStatus,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    });
  }
  return ids.map((id) => byId.get(id)).filter((c): c is ChangeEntry => c !== undefined);
}

/**
 * Logs a change someone made, with how to undo it. A person logs it as themselves; an agent
 * logs it for its owner, who must be a person. Names and short identifiers only: TeamKit stores
 * no secret values, and never acts on `undoWhen`.
 */
export async function logChange(db: Db, auth: AuthContext, input: ChangeInput): Promise<ChangeEntry> {
  const room = assertRoomName(input.room);
  const what = assertShort("what", input.what, MAX_WHAT, { required: true })!;
  const where = assertShort("where", input.where, MAX_WHERE, { required: true })!;
  const undo = assertShort("undo", input.undo, MAX_WHAT, { required: true })!;
  const undoWhen = assertShort("undoWhen", input.undoWhen, MAX_WHERE) ?? null;
  let at: string | null = null;
  if (input.at !== undefined) {
    if (typeof input.at !== "string" || !ISO_START.test(input.at) || Number.isNaN(Date.parse(input.at))) {
      throw new BoardError("invalid_input", "at must be an ISO date-time, such as 2026-11-19T14:00:00Z");
    }
    at = new Date(input.at).toISOString();
  }
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "post");
    let person: ActorRef;
    let agent: ActorRef | null = null;
    if (auth.actor.kind === "person") {
      person = auth.actor;
    } else {
      const owner = await ownerOf(tx, auth.actor.id);
      if (!owner) throw new BoardError("forbidden", `${auth.actor.name} has no owner who is a person, so it cannot log a change`);
      person = owner;
      agent = auth.actor;
    }
    const threadId = input.threadId ?? null;
    if (threadId !== null) {
      const [th] = await tx`select room from threads where id = ${threadId}`;
      if (!th) throw new BoardError("not_found", `thread ${threadId} not found`);
      if (th.room !== room) throw new BoardError("invalid_input", `thread ${threadId} is in ${th.room as string}, not ${room}`);
    }
    const id = newId(ID_PREFIXES.change);
    await tx`
      insert into changes (id, room, thread_id, what, where_text, at, person_id, agent_id, undo, undo_when)
      values (${id}, ${room}, ${threadId}, ${what}, ${where}, ${at ?? tx`clock_timestamp()`}, ${person.id}, ${agent?.id ?? null},
              ${undo}, ${undoWhen})`;
    const change = (await loadChanges(tx, [id]))[0]!;
    await appendEvent(tx, {
      kind: "change.logged",
      room,
      threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.change.logged", { change })],
      data: { changeId: id, status: "active" },
    });
    return change;
  });
}

/** Marks a change active, done or restored. The status it already has changes nothing. */
export async function updateChange(db: Db, auth: AuthContext, id: string, status: ChangeStatus): Promise<ChangeEntry> {
  const next = checkStatus(status);
  return db.begin(async (tx) => {
    const [c] = await tx`select room, thread_id, status from changes where id = ${id} for update`;
    if (!c) throw new BoardError("not_found", `change ${id} not found`);
    await requirePerm(tx, auth, c.room as string, "post");
    const previous = c.status as ChangeStatus;
    if (previous !== next) {
      await tx`update changes set status = ${next}, updated_at = clock_timestamp() where id = ${id}`;
      await appendEvent(tx, {
        kind: "change.updated",
        room: c.room as string,
        threadId: (c.thread_id as string | null) ?? null,
        actorId: auth.actor.id,
        agui: [custom("teamkit.change.updated", { changeId: id, status: next, previous })],
        data: { changeId: id, status: next, previous },
      });
    }
    return (await loadChanges(tx, [id]))[0]!;
  });
}

/** The room's change log, newest `at` first. */
export async function listChanges(
  db: Db,
  auth: AuthContext,
  room: string,
  opts?: { status?: ChangeStatus; limit?: number },
): Promise<ChangeEntry[]> {
  const limit = listLimit(opts?.limit);
  assertRoomName(room);
  const status = opts?.status === undefined ? undefined : checkStatus(opts.status);
  await requirePerm(db, auth, room, "read");
  const rows = await db`
    select id from changes
    where room = ${room} ${status === undefined ? db`` : db`and status = ${status}`}
    order by at desc, created_at desc, id desc limit ${limit}`;
  return loadChanges(db, rows.map((r) => r.id as string));
}

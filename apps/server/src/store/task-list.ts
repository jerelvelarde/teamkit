import {
  BoardError,
  TASK_STATES,
  isValidRoomPattern,
  type Task,
  type TaskState,
} from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { can, requirePerm, type AuthContext } from "./actors.js";
import { loadTasks } from "./task-load.js";

export interface ListTasksInput {
  room?: string;
  state?: TaskState | "all";
  labels?: Record<string, string>;
}

export async function listTasks(db: Db, auth: AuthContext, input: ListTasksInput = {}): Promise<Task[]> {
  const { room, state, labels } = input;
  if (auth.scope === "admin") {
    throw new BoardError("forbidden", `${auth.actor.name} uses an admin token, which cannot list tasks`);
  }
  if (room !== undefined && (typeof room !== "string" || !isValidRoomPattern(room))) {
    throw new BoardError("invalid_input", `invalid room: ${String(room)}`);
  }
  if (state !== undefined && state !== "all" && !(TASK_STATES as readonly string[]).includes(state)) {
    throw new BoardError("invalid_input", `invalid state: ${String(state)}`);
  }
  const allRooms = room === undefined || room === "*";
  if (auth.actor.kind === "agent" && !allRooms) {
    await requirePerm(db, auth, room.endsWith("/") ? room.slice(0, -1) : room, "read");
  }
  const roomFilter = allRooms
    ? db``
    : room.endsWith("/")
      ? db`and (th.room = ${room.slice(0, -1)} or th.room like ${room.replace(/[\\%_]/g, "\\$&") + "%"})`
      : db`and th.room = ${room}`;
  const stateFilter =
    state === undefined
      ? db`and t.state not in ('completed', 'failed')`
      : state === "all"
        ? db``
        : db`and t.state = ${state}`;
  const labelFilter = labels ? db`and th.labels @> ${db.json(labels)}` : db``;
  const rows = await db<{ thread_id: string; room: string }[]>`
    select t.thread_id, th.room
    from tasks t join threads th on th.id = t.thread_id
    where true ${roomFilter} ${stateFilter} ${labelFilter}
    order by th.created_at, t.thread_id`;
  // The up-front check only covers the base room. A prefix query also matches child
  // rooms an exact grant does not reach, so every row is checked against its own room.
  let kept: { thread_id: string; room: string }[] = rows;
  if (auth.actor.kind === "agent") {
    const readable = new Map<string, boolean>();
    kept = [];
    for (const r of rows) {
      let ok = readable.get(r.room);
      if (ok === undefined) {
        ok = await can(db, auth.actor, r.room, "read");
        readable.set(r.room, ok);
      }
      if (ok) kept.push(r);
    }
  }
  return loadTasks(db, kept.map((r) => r.thread_id));
}

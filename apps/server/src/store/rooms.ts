import {
  BoardError,
  roomMatches,
  type RoomInfo,
  type RoomSummary,
  type RoomView,
  type TaskState,
  type ThreadSummary,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { ensureRoom } from "./rows.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { currentCursor } from "./events.js";
import { validateEventQuery } from "./feed.js";

const SLACK_ANNOUNCE = ["blocked", "all", "none"] as const;

export interface RoomSettings {
  agent?: string | null;
  approvers?: string[] | null;
  slackChannel?: string | null;
  slackAnnounce?: "blocked" | "all" | "none";
}

function toInfo(r: Record<string, unknown>): RoomInfo {
  return {
    name: r.name as string,
    createdAt: (r.created_at as Date).toISOString(),
    agent: (r.agent as string | null) ?? null,
    approvers: (r.approvers as string[] | null) ?? null,
    slackChannel: (r.slack_channel as string | null) ?? null,
    slackAnnounce: r.slack_announce as RoomInfo["slackAnnounce"],
  };
}

/** Rooms the actor can read (people see all), sorted by name. Admin-scope tokens are refused. */
export async function listRooms(db: Db, auth: AuthContext): Promise<RoomSummary[]> {
  if (auth.scope === "admin") {
    throw new BoardError("forbidden", `${auth.actor.name} uses an admin token, which cannot list rooms`);
  }
  const rows: Record<string, unknown>[] = [...(await db`select name, created_at from rooms order by name`)];
  let visible = rows;
  if (auth.actor.kind !== "person") {
    const grants = await db`select room_pattern, perms from grants where actor_id = ${auth.actor.id}`;
    const readable = grants
      .filter((g) => (g.perms as string[]).includes("read"))
      .map((g) => g.room_pattern as string);
    visible = rows.filter((r) => readable.some((p) => roomMatches(p, r.name as string)));
  }
  return visible.map((r) => ({
    name: r.name as string,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

/** Every room with its settings, sorted by name. No auth check; admin routes gate it. */
export async function listRoomInfos(q: Q): Promise<RoomInfo[]> {
  const rows = await q`select * from rooms order by name`;
  return rows.map(toInfo);
}

/** No auth check; for internal callers. */
export async function getRoomInfo(q: Q, name: string): Promise<RoomInfo | null> {
  const [r] = await q`select * from rooms where name = ${name}`;
  return r ? toInfo(r) : null;
}

export async function getRoom(
  db: Db,
  auth: AuthContext,
  name: string,
  opts?: { after?: string },
): Promise<RoomView> {
  const after = opts?.after;
  validateEventQuery({ after });
  await requirePerm(db, auth, name, "read");
  // Read the cursor first so no event committed after this point is skipped by a follower.
  const cursor = await currentCursor(db);
  const room = await getRoomInfo(db, name);
  if (!room) throw new BoardError("not_found", `room not found: ${name}`);
  const rows = await db`
    select t.id, t.room, t.is_task, t.labels, t.created_at,
           a.id as actor_id, a.name as actor_name, a.kind as actor_kind,
           k.state, k.brief
    from threads t
    join actors a on a.id = t.created_by
    left join tasks k on k.thread_id = t.id
    where t.room = ${name}
      ${
        after !== undefined
          ? db`and exists (select 1 from events e where e.thread_id = t.id and e.cursor > ${after}::bigint)`
          : db``
      }
    order by t.created_at, t.id`;
  const threads: ThreadSummary[] = rows.map((r) => ({
    id: r.id as string,
    room: r.room as string,
    isTask: r.is_task as boolean,
    labels: r.labels as Record<string, string>,
    createdBy: { id: r.actor_id as string, name: r.actor_name as string, kind: r.actor_kind },
    createdAt: (r.created_at as Date).toISOString(),
    state: (r.state as TaskState | null) ?? null,
    brief: (r.brief as string | null) ?? null,
  }));
  return { room, threads, cursor };
}

function checkNullableString(field: string, v: unknown): void {
  if (v !== null && typeof v !== "string") {
    throw new BoardError("invalid_input", `${field} must be a string or null`);
  }
}

/** Admin path, no auth. Creates the room if missing; undefined fields are left unchanged. */
export async function setRoom(db: Db, name: string, settings: RoomSettings): Promise<RoomInfo> {
  const s = settings;
  if (s.agent !== undefined) checkNullableString("agent", s.agent);
  if (s.slackChannel !== undefined) checkNullableString("slackChannel", s.slackChannel);
  if (s.approvers !== undefined && s.approvers !== null) {
    if (!Array.isArray(s.approvers)) throw new BoardError("invalid_input", "approvers must be an array or null");
    for (const a of s.approvers) {
      if (typeof a !== "string" || a === "") {
        throw new BoardError("invalid_input", "approver names must be non-empty strings");
      }
    }
  }
  if (s.slackAnnounce !== undefined && !SLACK_ANNOUNCE.includes(s.slackAnnounce)) {
    throw new BoardError("invalid_input", `slackAnnounce must be one of ${SLACK_ANNOUNCE.join(", ")}`);
  }
  return db.begin(async (tx) => {
    await ensureRoom(tx, name);
    const cols: Record<string, unknown> = {};
    if (s.agent !== undefined) cols.agent = s.agent;
    if (s.approvers !== undefined) cols.approvers = s.approvers;
    if (s.slackChannel !== undefined) cols.slack_channel = s.slackChannel;
    if (s.slackAnnounce !== undefined) cols.slack_announce = s.slackAnnounce;
    if (Object.keys(cols).length > 0) {
      await tx`update rooms set ${tx(cols as never, ...Object.keys(cols))} where name = ${name}`;
    }
    const [r] = await tx`select * from rooms where name = ${name}`;
    if (!r) throw new Error("setRoom: room row missing");
    return toInfo(r);
  });
}

import { BoardError, isValidRoomPattern, roomMatches, type ActorRef, type Presence } from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { MAX_STATUS_LENGTH, assertRoomName, assertShort } from "./coord-rows.js";

const MAX_WATCHING = 50;

/**
 * One agent install says it is on: one row per token, so each install reports its own presence.
 * Rows a week old are pruned on the way. Presence is polled and never logged as an event.
 */
export async function heartbeat(db: Db, auth: AuthContext, input: { watching: string[]; status?: string }): Promise<void> {
  if (auth.via !== "token" || auth.actor.kind !== "agent" || !auth.tokenId) {
    throw new BoardError("forbidden", "presence is reported by an agent token");
  }
  const raw: unknown = input.watching;
  if (!Array.isArray(raw) || raw.length > MAX_WATCHING) {
    throw new BoardError("invalid_input", `watching must be a list of at most ${MAX_WATCHING} room patterns`);
  }
  const watching: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || !isValidRoomPattern(p)) throw new BoardError("invalid_input", `not a room pattern: ${String(p)}`);
    if (!watching.includes(p)) watching.push(p);
  }
  const status = assertShort("status", input.status, MAX_STATUS_LENGTH) ?? null;
  await db.begin(async (tx) => {
    await tx`delete from presence where last_seen_at < clock_timestamp() - interval '7 days'`;
    await tx`
      insert into presence (token_id, actor_id, watching, status, last_seen_at)
      values (${auth.tokenId!}, ${auth.actor.id}, ${watching}, ${status}, clock_timestamp())
      on conflict (token_id) do update
        set watching = excluded.watching, status = excluded.status, last_seen_at = excluded.last_seen_at`;
  });
}

/**
 * Agents watching the room, from sessions seen in the last day on tokens not revoked: grouped
 * by agent (sorted by name), sessions newest first. No permission check: for server-side
 * readers such as the Slack status message.
 */
export async function loadPresence(q: Q, room: string): Promise<Presence[]> {
  const rows = await q`
    select p.token_id, p.watching, p.status, p.last_seen_at,
           a.id as a_id, a.name as a_name, a.kind as a_kind,
           o.id as o_id, o.name as o_name, o.kind as o_kind
    from presence p
    join tokens t on t.id = p.token_id and t.revoked_at is null
    join actors a on a.id = p.actor_id
    left join actors o on o.id = a.owner_id
    where p.last_seen_at > clock_timestamp() - interval '24 hours'
    order by a.name, p.last_seen_at desc`;
  const byAgent = new Map<string, Presence>();
  for (const r of rows) {
    const watching = r.watching as string[];
    if (!watching.some((p) => roomMatches(p, room))) continue;
    const id = r.a_id as string;
    let p = byAgent.get(id);
    if (!p) {
      const owner: ActorRef | null = r.o_id
        ? { id: r.o_id as string, name: r.o_name as string, kind: r.o_kind as ActorRef["kind"] }
        : null;
      p = { actor: { id, name: r.a_name as string, kind: r.a_kind as ActorRef["kind"] }, owner, sessions: [] };
      byAgent.set(id, p);
    }
    p.sessions.push({
      tokenId: r.token_id as string,
      watching,
      status: (r.status as string | null) ?? null,
      lastSeenAt: (r.last_seen_at as Date).toISOString(),
    });
  }
  return [...byAgent.values()];
}

/** Agents watching the room, for a caller who can read it. */
export async function listPresence(db: Db, auth: AuthContext, room: string): Promise<Presence[]> {
  assertRoomName(room);
  await requirePerm(db, auth, room, "read");
  return loadPresence(db, room);
}

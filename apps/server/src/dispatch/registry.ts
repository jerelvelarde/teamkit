import {
  BoardError,
  isValidRoomPattern,
  newId,
  type ActorRef,
  type AgentInfo,
  type AgentRegistration,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";

export interface RegisteredAgent {
  name: string;
  actor: ActorRef;
  url: string;
  headers: Record<string, string>;
  rooms: string[];
  enabled: boolean;
  createdAt: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const AGENT_PERMS = ["read", "post", "claim", "create"];

/** The server holds a registered agent's actor; no token for it is ever handed out. */
export function agentAuthContext(a: RegisteredAgent): AuthContext {
  return { actor: a.actor, via: "system", scope: "agent", role: null };
}

/** Header values are secrets and never leave the server. */
export function toAgentInfo(a: RegisteredAgent): AgentInfo {
  return {
    name: a.name,
    actor: a.actor,
    url: a.url,
    rooms: a.rooms,
    headerNames: Object.keys(a.headers).sort(),
    enabled: a.enabled,
    createdAt: a.createdAt,
  };
}

function toAgent(r: Record<string, unknown>): RegisteredAgent {
  return {
    name: r.name as string,
    actor: { id: r.actor_id as string, name: r.name as string, kind: "agent" },
    url: r.url as string,
    headers: (r.headers as Record<string, string>) ?? {},
    rooms: r.rooms as string[],
    enabled: r.enabled as boolean,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

function validate(input: AgentRegistration): Record<string, string> {
  const { name, url, rooms, headers } = input;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new BoardError("invalid_input", `invalid agent name: ${String(name)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BoardError("invalid_input", `invalid agent url: ${String(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BoardError("invalid_input", "agent url must be http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BoardError("invalid_input", "agent url must not contain credentials; use headers");
  }
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new BoardError("invalid_input", "rooms must be a non-empty array");
  }
  for (const r of rooms) {
    if (typeof r !== "string" || !isValidRoomPattern(r)) {
      throw new BoardError("invalid_input", `invalid room pattern: ${String(r)}`);
    }
  }
  const h = headers ?? {};
  if (typeof h !== "object" || h === null || Array.isArray(h)) {
    throw new BoardError("invalid_input", "headers must be an object");
  }
  for (const [k, v] of Object.entries(h)) {
    if (!HEADER_NAME_RE.test(k)) throw new BoardError("invalid_input", `invalid header name: ${k}`);
    if (typeof v !== "string") throw new BoardError("invalid_input", `header ${k} must be a string`);
  }
  return h;
}

async function replaceGrants(tx: Q, actorId: string, rooms: string[]): Promise<void> {
  await tx`delete from grants where actor_id = ${actorId}`;
  for (const room of new Set(rooms)) {
    await tx`insert into grants (actor_id, room_pattern, perms) values (${actorId}, ${room}, ${AGENT_PERMS})`;
  }
}

export async function registerAgent(
  db: Db,
  input: AgentRegistration & { ownerId?: string | null },
): Promise<RegisteredAgent> {
  const headers = validate(input);
  const rooms = [...new Set(input.rooms)];
  const ownerId = input.ownerId ?? null;
  const name = input.name;
  return db.begin(async (tx) => {
    const [existing] = await tx`select actor_id from agents where name = ${name} for update`;
    if (existing) {
      await tx`
        update agents set url = ${input.url}, headers = ${tx.json(headers)}, rooms = ${rooms}, enabled = true
        where name = ${name}`;
      await replaceGrants(tx, existing.actor_id as string, rooms);
    } else {
      const [taken] = await tx`select 1 as x from actors where name = ${name}`;
      if (taken) throw new BoardError("invalid_input", `name ${name} is taken`);
      if (ownerId !== null) {
        const [o] = await tx`select 1 as x from actors where id = ${ownerId}`;
        if (!o) throw new BoardError("invalid_input", "unknown owner");
      }
      const id = newId("ac");
      try {
        await tx`insert into actors (id, kind, name, owner_id) values (${id}, 'agent', ${name}, ${ownerId})`;
      } catch (e) {
        if ((e as { code?: unknown }).code === "23505") {
          throw new BoardError("invalid_input", `name ${name} is taken`);
        }
        throw e;
      }
      await replaceGrants(tx, id, rooms);
      await tx`
        insert into agents (name, actor_id, url, headers, rooms)
        values (${name}, ${id}, ${input.url}, ${tx.json(headers)}, ${rooms})`;
    }
    const [row] = await tx`select * from agents where name = ${name}`;
    return toAgent(row!);
  });
}

export async function getAgent(q: Q, name: string): Promise<RegisteredAgent | null> {
  const [r] = await q`select * from agents where name = ${name}`;
  return r ? toAgent(r) : null;
}

export async function listAgents(db: Db): Promise<RegisteredAgent[]> {
  const rows = await db`select * from agents order by name`;
  return rows.map(toAgent);
}

export async function setAgentEnabled(db: Db, name: string, enabled: boolean): Promise<void> {
  const rows = await db`update agents set enabled = ${enabled} where name = ${name} returning name`;
  if (rows.length === 0) throw new BoardError("not_found", `agent not found: ${name}`);
}

/**
 * SQL for the name of the agent a task is routed to: the task label `agent`, else the task's
 * `target` when it names an enabled registered agent, else the room's agent. The query must
 * name the task row `t` and its thread `th`. The name may be of no agent, or a disabled one:
 * the task is routed to an agent only when the name is of an enabled registered agent.
 */
export function routedAgentName(q: Q) {
  return q`coalesce(
    th.labels->>'agent',
    (select ta.name from agents ta where ta.name = t.target and ta.enabled),
    (select r.agent from rooms r where r.name = th.room))`;
}

/** Ready tasks routed to an enabled registered agent (see routedAgentName). */
export async function listDispatchable(
  db: Db,
  limit: number,
): Promise<{ taskId: string; agent: RegisteredAgent }[]> {
  const rows = await db`
    select t.thread_id as task_id, a.*
    from tasks t
    join threads th on th.id = t.thread_id
    join agents a on a.name = ${routedAgentName(db)}
    where t.state = 'ready' and a.enabled
    order by th.created_at, t.thread_id
    limit ${limit}`;
  return rows.map((r) => ({ taskId: r.task_id as string, agent: toAgent(r) }));
}

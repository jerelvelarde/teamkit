import {
  BoardError,
  PERMISSIONS,
  isValidRoomPattern,
  newId,
  newTokenSecret,
  personAgentName,
  roomMatches,
  type ActorRef,
  type Permission,
} from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db, Q } from "../db/pool.js";

export interface AuthContext {
  actor: ActorRef;
  via: "token" | "session" | "system";
  scope: "agent" | "admin" | null;
  role: "admin" | "member" | null;
  /** The bearer token's id, so each install reports its own presence. Unset for sessions. */
  tokenId?: string;
}

export interface Grant {
  room: string;
  perms: Permission[];
}

export interface CreatedAgent {
  actor: ActorRef;
  token: string;
  tokenId: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PERM_SET: ReadonlySet<string> = new Set(PERMISSIONS);

function checkName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new BoardError("invalid_input", `invalid actor name: ${String(name)}`);
  }
}

/** Validates grants and merges duplicate patterns (union of perms). */
function normalizeGrants(grants: Grant[]): Grant[] {
  const merged = new Map<string, Set<Permission>>();
  for (const g of grants) {
    if (typeof g.room !== "string" || !isValidRoomPattern(g.room)) {
      throw new BoardError("invalid_input", `invalid room pattern: ${String(g.room)}`);
    }
    if (!Array.isArray(g.perms)) throw new BoardError("invalid_input", "perms must be an array");
    for (const p of g.perms) {
      if (!PERM_SET.has(p)) throw new BoardError("invalid_input", `unknown permission: ${String(p)}`);
    }
    const set = merged.get(g.room) ?? new Set<Permission>();
    for (const p of g.perms) set.add(p);
    merged.set(g.room, set);
  }
  return [...merged].map(([room, set]) => ({ room, perms: [...set] }));
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * The person's own agent, `<person>-agent`: created on first use, owned by them, and given
 * read, post, claim and create in each room. Grants only ever add up, so another install of
 * the same agent keeps every room it had.
 */
export async function ensureOwnedAgent(q: Q, owner: ActorRef, rooms: string[]): Promise<ActorRef> {
  const name = personAgentName(owner.name);
  await q`insert into actors (id, kind, name, owner_id) values (${newId("ac")}, 'agent', ${name}, ${owner.id})
          on conflict (name) do nothing`;
  const [row] = await q`select id, kind, owner_id from actors where name = ${name}`;
  if (!row || row.kind !== "agent" || row.owner_id !== owner.id) {
    throw new BoardError("name_taken", `the name ${name} belongs to someone else; ask an admin`);
  }
  const perms = [...PERMISSIONS];
  for (const room of rooms) {
    await q`insert into grants (actor_id, room_pattern, perms) values (${row.id as string}, ${room}, ${perms})
            on conflict (actor_id, room_pattern) do update set perms = excluded.perms`;
  }
  return { id: row.id as string, name, kind: "agent" };
}

async function insertAgent(
  tx: Q,
  name: string,
  ownerId: string | null,
  grants: Grant[],
): Promise<CreatedAgent> {
  const [taken] = await tx`select 1 as x from actors where name = ${name}`;
  if (taken) throw new BoardError("invalid_input", `actor name already taken: ${name}`);
  const id = newId("ac");
  try {
    await tx`insert into actors (id, kind, name, owner_id) values (${id}, 'agent', ${name}, ${ownerId})`;
  } catch (e) {
    if (isUniqueViolation(e)) throw new BoardError("invalid_input", `actor name already taken: ${name}`);
    throw e;
  }
  for (const g of grants) {
    await tx`insert into grants (actor_id, room_pattern, perms) values (${id}, ${g.room}, ${g.perms})`;
  }
  const token = newTokenSecret();
  const tokenId = newId("tok");
  await tx`insert into tokens (id, actor_id, hash, scope) values (${tokenId}, ${id}, ${hashToken(token)}, 'agent')`;
  return { actor: { id, name, kind: "agent" }, token, tokenId };
}

async function checkOwner(tx: Q, ownerId: string | null): Promise<void> {
  if (ownerId === null) return;
  const [o] = await tx`select 1 as x from actors where id = ${ownerId}`;
  if (!o) throw new BoardError("invalid_input", "unknown owner");
}

export async function createAgent(
  db: Db,
  input: { name: string; ownerId?: string | null; grants: Grant[] },
): Promise<CreatedAgent> {
  checkName(input.name);
  const grants = normalizeGrants(input.grants);
  const ownerId = input.ownerId ?? null;
  return db.begin(async (tx) => {
    await checkOwner(tx, ownerId);
    return insertAgent(tx, input.name, ownerId, grants);
  });
}

export async function createAgentTokens(
  db: Db,
  input: { baseName: string; count: number; ownerId?: string | null; grants: Grant[] },
): Promise<CreatedAgent[]> {
  const { baseName, count } = input;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new BoardError("invalid_input", "count must be an integer from 1 to 100");
  }
  const names = Array.from({ length: count }, (_, i) => `${baseName}-${i + 1}`);
  for (const n of names) checkName(n);
  const grants = normalizeGrants(input.grants);
  const ownerId = input.ownerId ?? null;
  return db.begin(async (tx) => {
    await checkOwner(tx, ownerId);
    const out: CreatedAgent[] = [];
    for (const n of names) out.push(await insertAgent(tx, n, ownerId, grants));
    return out;
  });
}

export async function createPerson(
  db: Q,
  input: { name: string; role: "admin" | "member" },
): Promise<ActorRef> {
  checkName(input.name);
  if (input.role !== "admin" && input.role !== "member") {
    throw new BoardError("invalid_input", "role must be admin or member");
  }
  const id = newId("ac");
  try {
    await db`insert into actors (id, kind, name, role) values (${id}, 'person', ${input.name}, ${input.role})`;
  } catch (e) {
    if (isUniqueViolation(e)) throw new BoardError("invalid_input", `actor name already taken: ${input.name}`);
    throw e;
  }
  return { id, name: input.name, kind: "person" };
}

export async function revokeToken(db: Db, tokenId: string): Promise<void> {
  const rows = await db`
    update tokens set revoked_at = coalesce(revoked_at, now()) where id = ${tokenId} returning id`;
  if (rows.length === 0) throw new BoardError("not_found", `token not found: ${tokenId}`);
}

export async function listTokens(db: Db): Promise<
  {
    id: string;
    actorId: string;
    actorName: string;
    scope: "agent" | "admin";
    createdAt: string;
    revokedAt: string | null;
  }[]
> {
  const rows = await db`
    select t.id, t.actor_id, a.name as actor_name, t.scope, t.created_at, t.revoked_at
    from tokens t join actors a on a.id = t.actor_id
    order by t.created_at, t.id`;
  return rows.map((r) => ({
    id: r.id as string,
    actorId: r.actor_id as string,
    actorName: r.actor_name as string,
    scope: r.scope as "agent" | "admin",
    createdAt: (r.created_at as Date).toISOString(),
    revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
  }));
}

export async function authenticate(
  db: Db,
  bearer: string,
): Promise<{ actor: ActorRef; scope: "agent" | "admin"; role: "admin" | "member" | null; tokenId: string } | null> {
  if (typeof bearer !== "string" || bearer === "") return null;
  const [r] = await db`
    select a.id, a.name, a.kind, a.role, t.scope, t.id as token_id
    from tokens t join actors a on a.id = t.actor_id
    where t.hash = ${hashToken(bearer)} and t.revoked_at is null`;
  if (!r) return null;
  return {
    actor: { id: r.id as string, name: r.name as string, kind: r.kind as "agent" | "person" },
    scope: r.scope as "agent" | "admin",
    role: (r.role as "admin" | "member" | null) ?? null,
    tokenId: r.token_id as string,
  };
}

export async function can(q: Q, actor: ActorRef, room: string, perm: Permission): Promise<boolean> {
  if (actor.kind === "person") return true;
  const rows = await q`select room_pattern, perms from grants where actor_id = ${actor.id}`;
  return rows.some(
    (g) => roomMatches(g.room_pattern as string, room) && (g.perms as string[]).includes(perm),
  );
}

/**
 * Throws forbidden unless the caller may use `perm` in `room`. Admin-scope tokens
 * are for admin commands only (spec 7.5), so they hold no board permission at all.
 */
export async function requirePerm(
  q: Q,
  auth: AuthContext,
  room: string,
  perm: Permission,
): Promise<void> {
  if (auth.scope === "admin") {
    throw new BoardError("forbidden", `${auth.actor.name} uses an admin token, which cannot ${perm} in ${room}`);
  }
  if (!(await can(q, auth.actor, room, perm))) {
    throw new BoardError("forbidden", `${auth.actor.name} lacks ${perm} in ${room}`);
  }
}

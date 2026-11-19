import {
  BoardError,
  newId,
  newTokenSecret,
  type ActorRef,
  type PersonInfo,
  type Role,
} from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db, Q } from "../db/pool.js";
import { createPerson } from "./actors.js";

export const DEFAULT_PUBLIC_URL = "http://127.0.0.1:3000";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SIGNIN_LINK_TTL_MS = 24 * 3600 * 1000;

const BOOTSTRAP_LOCK = 7732;

export function signInUrl(publicUrl: string, secret: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/signin/${secret}`;
}

function newLinkSecret(): string {
  return "sl_" + newTokenSecret().slice(3);
}

function newSessionSecret(): string {
  return "ts_" + newTokenSecret().slice(3);
}

async function insertLink(q: Q, actorId: string, ttlMs: number): Promise<string> {
  const secret = newLinkSecret();
  // An expired link can never be used, so each new link clears the expired ones out.
  await q`delete from signin_links where expires_at <= clock_timestamp()`;
  await q`
    insert into signin_links (hash, actor_id, expires_at)
    values (${hashToken(secret)}, ${actorId}, clock_timestamp() + ${ttlMs}::float8 * interval '1 millisecond')`;
  return secret;
}

export async function createSignInLink(
  db: Db,
  actorId: string,
  ttlMs: number = SIGNIN_LINK_TTL_MS,
): Promise<string> {
  return insertLink(db, actorId, ttlMs);
}

export async function invitePerson(
  db: Db,
  input: { name: string; role: Role },
): Promise<{ person: ActorRef; role: Role; secret: string }> {
  const [existing] = await db`select id, name, kind, role from actors where name = ${input.name}`;
  if (existing && existing.kind !== "person") {
    throw new BoardError("invalid_input", `name ${input.name} belongs to an agent`);
  }
  if (existing) {
    const secret = await createSignInLink(db, existing.id as string);
    return {
      person: { id: existing.id as string, name: existing.name as string, kind: "person" },
      role: existing.role as Role,
      secret,
    };
  }
  const person = await createPerson(db, input);
  const secret = await createSignInLink(db, person.id);
  return { person, role: input.role, secret };
}

export async function consumeSignInLink(
  db: Db,
  secret: string,
): Promise<{ actor: ActorRef; role: Role; sessionSecret: string; expiresAt: string }> {
  const invalid = () => new BoardError("unauthorized", "sign-in link is invalid, used or expired");
  if (typeof secret !== "string" || secret === "") throw invalid();
  return db.begin(async (tx) => {
    const [link] = await tx`
      update signin_links set used_at = clock_timestamp()
      where hash = ${hashToken(secret)} and used_at is null and expires_at > clock_timestamp()
      returning actor_id`;
    if (!link) throw invalid();
    const [a] = await tx`select id, name, kind, role from actors where id = ${link.actor_id as string}`;
    if (!a || a.kind !== "person") throw invalid();
    const sessionSecret = newSessionSecret();
    const [s] = await tx`
      insert into sessions (id, actor_id, hash, expires_at)
      values (${newId("ses")}, ${a.id as string}, ${hashToken(sessionSecret)},
              clock_timestamp() + ${SESSION_TTL_MS}::float8 * interval '1 millisecond')
      returning expires_at`;
    return {
      actor: { id: a.id as string, name: a.name as string, kind: "person" as const },
      role: a.role as Role,
      sessionSecret,
      expiresAt: (s!.expires_at as Date).toISOString(),
    };
  });
}

export async function authenticateSession(
  q: Q,
  secret: string,
): Promise<{ actor: ActorRef; role: Role } | null> {
  if (typeof secret !== "string" || secret === "") return null;
  const [r] = await q`
    select a.id, a.name, a.role
    from sessions s join actors a on a.id = s.actor_id
    where s.hash = ${hashToken(secret)} and s.revoked_at is null
      and s.expires_at > clock_timestamp() and a.kind = 'person'`;
  if (!r) return null;
  return {
    actor: { id: r.id as string, name: r.name as string, kind: "person" },
    role: r.role as Role,
  };
}

export async function revokeSession(db: Db, secret: string): Promise<boolean> {
  if (typeof secret !== "string" || secret === "") return false;
  const rows = await db`
    update sessions set revoked_at = clock_timestamp()
    where hash = ${hashToken(secret)} and revoked_at is null returning id`;
  return rows.length > 0;
}

export async function revokeAdminToken(db: Db, bearer: string): Promise<boolean> {
  if (typeof bearer !== "string" || bearer === "") return false;
  const rows = await db`
    update tokens set revoked_at = clock_timestamp()
    where hash = ${hashToken(bearer)} and scope = 'admin' and revoked_at is null returning id`;
  return rows.length > 0;
}

export async function listPeople(db: Db): Promise<PersonInfo[]> {
  const rows = await db`
    select a.id, a.name, a.role, a.created_at,
           (select max(s.created_at) from sessions s where s.actor_id = a.id) as last_sign_in
    from actors a where a.kind = 'person' order by a.name`;
  return rows.map((r) => ({
    actor: { id: r.id as string, name: r.name as string, kind: "person" as const },
    role: r.role as Role,
    createdAt: (r.created_at as Date).toISOString(),
    lastSignInAt: r.last_sign_in ? (r.last_sign_in as Date).toISOString() : null,
  }));
}

export async function ensureBootstrapLink(db: Db): Promise<string | null> {
  return db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`;
    const [anySession] = await tx`select 1 as x from sessions limit 1`;
    if (anySession) return null;
    const [admin] = await tx`
      select id from actors where kind = 'person' and role = 'admin' order by created_at, id limit 1`;
    let adminId = admin?.id as string | undefined;
    if (!adminId) {
      const [agentTaken] = await tx`select 1 as x from actors where name = 'admin' and kind = 'agent'`;
      const name = agentTaken ? "teamkit-admin" : "admin";
      adminId = newId("ac");
      await tx`insert into actors (id, kind, name, role) values (${adminId}, 'person', ${name}, 'admin')`;
    }
    return insertLink(tx, adminId, SIGNIN_LINK_TTL_MS);
  });
}

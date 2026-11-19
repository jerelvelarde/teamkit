import {
  BoardError,
  MAX_JOIN_LINK_DAYS,
  MAX_JOIN_LINK_DOMAINS,
  emailDomain,
  newId,
  newTokenSecret,
  normalizeDomain,
  normalizeEmail,
  normalizeJoinName,
  personAgentName,
  type ActorRef,
  type JoinLink,
} from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db, Q } from "../db/pool.js";
import { insertSession } from "./people.js";

const INVALID_LINK = "this join link is invalid, revoked or expired";

export function joinUrl(publicUrl: string, secret: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/join/${secret}`;
}

function newJoinSecret(): string {
  return "jc_" + newTokenSecret().slice(3);
}

function iso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

function toJoinLink(r: Record<string, unknown>): JoinLink {
  return {
    id: r.id as string,
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at),
    domains: (r.domains as string[] | null) ?? null,
    revokedAt: iso(r.revoked_at),
    uses: Number(r.uses),
  };
}

function parseDomains(raw: string[] | undefined): string[] | null {
  if (raw === undefined || raw.length === 0) return null;
  const domains: string[] = [];
  for (const d of raw) {
    const n = normalizeDomain(d);
    if (n === null) throw new BoardError("invalid_input", `not a domain: ${d}`);
    if (!domains.includes(n)) domains.push(n);
  }
  if (domains.length > MAX_JOIN_LINK_DOMAINS) {
    throw new BoardError("invalid_input", `a join link takes at most ${MAX_JOIN_LINK_DOMAINS} domains`);
  }
  return domains;
}

export async function createJoinLink(
  db: Db,
  input: { createdBy: string | null; expiresInDays?: number; domains?: string[] },
): Promise<{ joinLink: JoinLink; secret: string }> {
  const days = input.expiresInDays;
  if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= MAX_JOIN_LINK_DAYS)) {
    throw new BoardError("invalid_input", `expiresInDays must be a whole number from 1 to ${MAX_JOIN_LINK_DAYS}`);
  }
  const domains = parseDomains(input.domains);
  const secret = newJoinSecret();
  const [row] = await db`
    insert into join_links (id, hash, created_by, expires_at, domains)
    values (${newId("jl")}, ${hashToken(secret)}, ${input.createdBy},
            ${days === undefined ? null : db`clock_timestamp() + ${days}::int * interval '1 day'`}, ${domains})
    returning id, created_at, expires_at, domains, revoked_at, uses`;
  return { joinLink: toJoinLink(row!), secret };
}

/** Newest first. Never returns a secret: only its hash is stored. */
export async function listJoinLinks(q: Q): Promise<JoinLink[]> {
  const rows = await q`
    select id, created_at, expires_at, domains, revoked_at, uses from join_links order by created_at desc, id desc`;
  return rows.map(toJoinLink);
}

/** Revoking twice keeps the first time. */
export async function revokeJoinLink(db: Db, id: string): Promise<void> {
  const [r] = await db`
    update join_links set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = ${id} returning id`;
  if (!r) throw new BoardError("not_found", `join link not found: ${id}`);
}

function isUniqueViolation(e: unknown): e is { constraint_name?: string } {
  return (e as { code?: string } | null)?.code === "23505";
}

/** Joins the team: a new member person with an email, signed in, in one transaction. */
export async function redeemJoinLink(
  db: Db,
  input: { code: string; name: string; email: string },
): Promise<{ actor: ActorRef; role: "member"; sessionSecret: string; expiresAt: string }> {
  if (typeof input.code !== "string" || input.code === "") throw new BoardError("join_link_invalid", INVALID_LINK);
  const hash = hashToken(input.code);
  return db.begin(async (tx) => {
    const [link] = await tx`
      select id, domains from join_links
      where hash = ${hash} and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())
      for update`;
    if (!link) throw new BoardError("join_link_invalid", INVALID_LINK);

    const name = normalizeJoinName(String(input.name ?? ""));
    if (name === null) {
      throw new BoardError("invalid_input", "names are lowercase letters, digits and hyphens, up to 57 characters");
    }
    const email = normalizeEmail(String(input.email ?? ""));
    if (email === null) throw new BoardError("invalid_input", "that is not an email address");
    const domains = (link.domains as string[] | null) ?? null;
    if (domains !== null && domains.length > 0 && !domains.includes(emailDomain(email))) {
      throw new BoardError("email_domain_not_allowed", `this join link only accepts emails at ${domains.join(", ")}`);
    }

    if ((await tx`select 1 from actors where name = ${name}`).length > 0) {
      throw new BoardError("name_taken", `the name ${name} is taken`);
    }
    const agentName = personAgentName(name);
    if ((await tx`select 1 from actors where name = ${agentName}`).length > 0) {
      throw new BoardError("name_taken", `the name ${name} is taken: ${agentName} is already in use`);
    }
    if ((await tx`select 1 from actors where email = ${email}`).length > 0) {
      throw new BoardError("email_taken", "that email already belongs to someone on this team");
    }

    const id = newId("ac");
    try {
      await tx`insert into actors (id, kind, name, role, email) values (${id}, 'person', ${name}, 'member', ${email})`;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (e.constraint_name === "actors_email_idx") {
        throw new BoardError("email_taken", "that email already belongs to someone on this team");
      }
      throw new BoardError("name_taken", `the name ${name} is taken`);
    }
    await tx`update join_links set uses = uses + 1 where id = ${link.id as string}`;
    const session = await insertSession(tx, id);
    return { actor: { id, name, kind: "person" as const }, role: "member" as const, ...session };
  });
}

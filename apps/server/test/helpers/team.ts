import type { ActorRef } from "@copilotkit/teamkit-protocol";
import type { Db } from "../../src/db/pool.js";
import { createAgent, type AuthContext, type Grant } from "../../src/store/actors.js";
import { consumeSignInLink, invitePerson } from "../../src/store/people.js";
import { setRoom } from "../../src/store/rooms.js";

export interface TeamPerson { actor: ActorRef; auth: AuthContext; session: string }
export interface TeamAgent { actor: ActorRef; auth: AuthContext; token: string; tokenId: string }
export interface BillingTeam { ana: TeamPerson; ben: TeamPerson; sam: TeamPerson; anaAgent: TeamAgent; benAgent: TeamAgent; samAgent: TeamAgent }

export const ROOMS = ["billing-migration", "billing-prod"] as const;

async function person(db: Db, name: string, role: "admin" | "member"): Promise<TeamPerson> {
  const invite = await invitePerson(db, { name, role });
  const s = await consumeSignInLink(db, invite.secret);
  return { actor: s.actor, auth: { actor: s.actor, via: "session", scope: null, role }, session: s.sessionSecret };
}

async function agent(db: Db, owner: TeamPerson): Promise<TeamAgent> {
  const grants: Grant[] = ROOMS.map((room) => ({ room, perms: ["read", "post", "claim", "create"] }));
  const a = await createAgent(db, { name: `${owner.actor.name}-agent`, ownerId: owner.actor.id, grants });
  return {
    actor: a.actor,
    auth: { actor: a.actor, via: "token", scope: "agent", role: null, tokenId: a.tokenId },
    token: a.token,
    tokenId: a.tokenId,
  };
}

/**
 * ana (admin), ben and sam (members), signed in; ana-agent, ben-agent and sam-agent owned by them
 * with read, post, claim and create in both rooms; billing-prod's approvers are ["sam"].
 */
export async function billingTeam(db: Db): Promise<BillingTeam> {
  const ana = await person(db, "ana", "admin");
  const ben = await person(db, "ben", "member");
  const sam = await person(db, "sam", "member");
  const team: BillingTeam = {
    ana,
    ben,
    sam,
    anaAgent: await agent(db, ana),
    benAgent: await agent(db, ben),
    samAgent: await agent(db, sam),
  };
  await setRoom(db, "billing-migration", {});
  await setRoom(db, "billing-prod", { approvers: ["sam"] });
  return team;
}

/** A fetch that adds `cookie: teamkit_session=<session>`, for createClient({ url, fetch }) against a test server. */
export function sessionFetch(session: string): typeof fetch {
  return (url, init) =>
    fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: `teamkit_session=${session}` } });
}

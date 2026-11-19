import { BoardError, newTokenSecret, type ActorRef, type Role } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db, Q } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";

/** A link code lives ten minutes: long enough to open the page, short enough to limit a forwarded link. */
export const SLACK_LINK_TTL_MS = 600_000;
const MAX_HANDLE_LENGTH = 80;

export interface SlackLinkPreview {
  slackUserId: string;
  slackUserName: string | null;
  expiresAt: string;
}

export interface LinkedSlackUser {
  slackUserId: string;
  slackUserName: string | null;
  linkedAt: string;
}

export function slackLinkUrl(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/link/slack?code=${code}`;
}

/** A Slack handle as display text: no control characters, trimmed, at most 80 characters, or null. */
function cleanHandle(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^@+/, "").trim();
  if (clean === "") return null;
  return clean.length > MAX_HANDLE_LENGTH ? clean.slice(0, MAX_HANDLE_LENGTH) : clean;
}

/** Linking is something a person does for themselves, signed in on the web board. */
function requirePersonSession(auth: AuthContext): void {
  if (auth.via !== "session" || auth.actor.kind !== "person") {
    throw new BoardError("forbidden", "only a signed-in person can link a Slack account");
  }
}

const invalidCode = () => new BoardError("not_found", "this Slack link is invalid, used or expired");

/**
 * A one-time code that links `slackUserId` to whoever redeems it. The code is stored only as a
 * hash, with the Slack handle so the link page can show which Slack account it is for. Each new
 * code also deletes the expired ones.
 */
export async function createSlackLinkCode(
  db: Db,
  slackUserId: string,
  opts: { slackUserName?: string | null; ttlMs?: number } = {},
): Promise<string> {
  const code = "slk_" + newTokenSecret().slice(3);
  const ttlMs = opts.ttlMs ?? SLACK_LINK_TTL_MS;
  await db`delete from slack_link_codes where expires_at <= clock_timestamp()`;
  await db`
    insert into slack_link_codes (hash, slack_user_id, slack_user_name, expires_at)
    values (${hashToken(code)}, ${slackUserId}, ${cleanHandle(opts.slackUserName)},
            clock_timestamp() + ${ttlMs}::float8 * interval '1 millisecond')`;
  return code;
}

/** Which Slack user a code would link, without using it up. */
export async function previewSlackLinkCode(q: Q, auth: AuthContext, code: string): Promise<SlackLinkPreview> {
  requirePersonSession(auth);
  if (typeof code !== "string" || code === "") throw invalidCode();
  const [row] = await q`
    select slack_user_id, slack_user_name, expires_at from slack_link_codes
    where hash = ${hashToken(code)} and used_at is null and expires_at > clock_timestamp()`;
  if (!row) throw invalidCode();
  return {
    slackUserId: row.slack_user_id as string,
    slackUserName: (row.slack_user_name as string | null) ?? null,
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

/**
 * Links the code's Slack user to the signed-in person. `confirmSlackUserId` is the Slack user id
 * the person was shown and confirmed; a code for any other Slack user is refused and stays unused.
 */
export async function redeemSlackLinkCode(
  db: Db,
  auth: AuthContext,
  code: string,
  confirmSlackUserId: string,
): Promise<{ slackUserId: string; slackUserName: string | null; actor: ActorRef }> {
  requirePersonSession(auth);
  if (typeof code !== "string" || code === "") throw invalidCode();
  return db.begin(async (tx) => {
    const [row] = await tx`
      select slack_user_id, slack_user_name from slack_link_codes
      where hash = ${hashToken(code)} and used_at is null and expires_at > clock_timestamp()
      for update`;
    if (!row) throw invalidCode();
    const slackUserId = row.slack_user_id as string;
    const slackUserName = (row.slack_user_name as string | null) ?? null;
    if (slackUserId !== confirmSlackUserId) {
      throw new BoardError("invalid_input", "this Slack link is for a different Slack user than the one confirmed");
    }
    await tx`update slack_link_codes set used_at = clock_timestamp() where hash = ${hashToken(code)}`;
    await tx`
      insert into slack_links (slack_user_id, actor_id, slack_user_name)
      values (${slackUserId}, ${auth.actor.id}, ${slackUserName})
      on conflict (slack_user_id) do update
        set actor_id = excluded.actor_id, slack_user_name = excluded.slack_user_name,
            created_at = clock_timestamp()`;
    return { slackUserId, slackUserName, actor: auth.actor };
  });
}

/** The Slack users linked to the signed-in person. */
export async function listMySlackLinks(q: Q, auth: AuthContext): Promise<LinkedSlackUser[]> {
  requirePersonSession(auth);
  const rows = await q`
    select slack_user_id, slack_user_name, created_at from slack_links
    where actor_id = ${auth.actor.id} order by created_at, slack_user_id`;
  return rows.map((r) => ({
    slackUserId: r.slack_user_id as string,
    slackUserName: (r.slack_user_name as string | null) ?? null,
    linkedAt: (r.created_at as Date).toISOString(),
  }));
}

/** Unlinks one of the signed-in person's Slack users; not_found when it is not linked to them. */
export async function unlinkMySlackUser(db: Db, auth: AuthContext, slackUserId: string): Promise<void> {
  requirePersonSession(auth);
  const rows = await db`
    delete from slack_links where slack_user_id = ${slackUserId} and actor_id = ${auth.actor.id}
    returning slack_user_id`;
  if (rows.length === 0) throw new BoardError("not_found", `Slack user ${slackUserId} is not linked to you`);
}

export async function findLinkedPerson(
  q: Q,
  slackUserId: string,
): Promise<{ actor: ActorRef; role: Role } | null> {
  const [r] = await q`
    select a.id, a.name, a.role
    from slack_links l join actors a on a.id = l.actor_id
    where l.slack_user_id = ${slackUserId} and a.kind = 'person'`;
  if (!r) return null;
  return {
    actor: { id: r.id as string, name: r.name as string, kind: "person" },
    role: r.role as Role,
  };
}

export async function unlinkSlackUser(db: Db, slackUserId: string): Promise<boolean> {
  const rows = await db`delete from slack_links where slack_user_id = ${slackUserId} returning slack_user_id`;
  return rows.length > 0;
}

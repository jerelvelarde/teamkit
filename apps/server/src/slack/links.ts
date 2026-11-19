import { BoardError, newTokenSecret, type ActorRef, type Role } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db, Q } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";

export const SLACK_LINK_TTL_MS = 3600000;

export function slackLinkUrl(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/link/slack?code=${code}`;
}

export async function createSlackLinkCode(
  db: Db,
  slackUserId: string,
  ttlMs: number = SLACK_LINK_TTL_MS,
): Promise<string> {
  const code = "slk_" + newTokenSecret().slice(3);
  await db`
    insert into slack_link_codes (hash, slack_user_id, expires_at)
    values (${hashToken(code)}, ${slackUserId},
            clock_timestamp() + ${ttlMs}::float8 * interval '1 millisecond')`;
  return code;
}

export async function redeemSlackLinkCode(
  db: Db,
  auth: AuthContext,
  code: string,
): Promise<{ slackUserId: string; actor: ActorRef }> {
  if (auth.via !== "session" || auth.actor.kind !== "person") {
    throw new BoardError("forbidden", "only a signed-in person can link a Slack account");
  }
  const invalid = () => new BoardError("not_found", "this Slack link is invalid, used or expired");
  if (typeof code !== "string" || code === "") throw invalid();
  return db.begin(async (tx) => {
    const [row] = await tx`
      update slack_link_codes set used_at = clock_timestamp()
      where hash = ${hashToken(code)} and used_at is null and expires_at > clock_timestamp()
      returning slack_user_id`;
    if (!row) throw invalid();
    const slackUserId = row.slack_user_id as string;
    await tx`
      insert into slack_links (slack_user_id, actor_id) values (${slackUserId}, ${auth.actor.id})
      on conflict (slack_user_id) do update
        set actor_id = excluded.actor_id, created_at = clock_timestamp()`;
    return { slackUserId, actor: auth.actor };
  });
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

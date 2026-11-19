import { createHmac, timingSafeEqual } from "node:crypto";
import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { escapeMrkdwn } from "./cards.js";
import { alertAsPerson, decideAsPerson } from "./coordination.js";
import { NOT_MAPPED } from "./handlers.js";
import { createSlackLinkCode, findLinkedPerson, slackLinkUrl } from "./links.js";
import { roomForSlackChannel } from "./mirror.js";

/** A signed Slack request older (or newer) than this is refused, so a captured one cannot be replayed. */
export const SLACK_SIGNATURE_MAX_AGE_S = 300;

const USAGE = "Use `/teamkit decide <what was decided>` or `/teamkit alert <what is wrong>` in a channel linked to a TeamKit room.";
const COMMAND_RE = /^(decide|alert)\s+(\S[\s\S]*)$/i;

/**
 * Slack's v0 request signature: `v0=` + HMAC-SHA256(secret, `v0:<timestamp>:<raw body>`), with the
 * timestamp within SLACK_SIGNATURE_MAX_AGE_S of now. Compared in constant time.
 */
export function verifySlackSignature(
  secret: string,
  h: { signature: string | undefined; timestamp: string | undefined },
  rawBody: string,
  nowMs: number,
): boolean {
  if (!h.signature || !h.timestamp || !/^\d+$/.test(h.timestamp)) return false;
  const ts = Number(h.timestamp);
  if (Math.abs(nowMs / 1000 - ts) > SLACK_SIGNATURE_MAX_AGE_S) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${h.timestamp}:${rawBody}`).digest("hex")}`);
  const given = Buffer.from(h.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface SlackCommandInput {
  userId: string;
  userName: string | null;
  channelId: string;
  text: string;
}

/**
 * `/teamkit decide <text>` records a decision, and `/teamkit alert <text>` raises an alert and
 * confirms it, both as the person linked to the Slack user, in the room linked to the channel.
 * Returns the ephemeral reply. An unlinked user is asked to link; an unmapped channel is refused.
 */
export async function handleSlackCommand(d: { db: Db; publicUrl: string }, input: SlackCommandInput): Promise<string> {
  const m = COMMAND_RE.exec(input.text.trim());
  if (!m) return USAGE;
  const sub = m[1]!.toLowerCase();
  const text = m[2]!.trim();
  const linked = await findLinkedPerson(d.db, input.userId);
  if (!linked) {
    const code = await createSlackLinkCode(d.db, input.userId, { slackUserName: input.userName });
    return `To use /teamkit, link your Slack account first: ${slackLinkUrl(d.publicUrl, code)}`;
  }
  const room = await roomForSlackChannel(d.db, input.channelId);
  if (room === null) return NOT_MAPPED;
  const auth = { actor: linked.actor, via: "session" as const, scope: null, role: linked.role };
  try {
    if (sub === "decide") {
      await decideAsPerson(d.db, auth, room, text);
      return `Decision recorded in ${escapeMrkdwn(room)}.`;
    }
    await alertAsPerson(d.db, auth, room, text);
    return `Alert raised in ${escapeMrkdwn(room)} and confirmed by you.`;
  } catch (e) {
    if (e instanceof BoardError) return `Could not record that: ${escapeMrkdwn(e.message)}`;
    throw e;
  }
}

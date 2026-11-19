import type { Alert, BoardEvent, EventKind } from "@copilotkit/teamkit-protocol";
import { toSlackMessage } from "./blocks.js";
import { AlertCard, DecisionCard } from "./cards.js";
import { entityIdOf, loadAlert, loadDecision } from "./coordination.js";
import { alertConfirmedLine } from "./lines.js";
import { getSlackPost, saveSlackPost, slackRoomSettings, type SlackPostRow } from "./mirror.js";
import type { EventOutcome, OutboundOptions } from "./outbound.js";
import { callSlack, type SlackMethod } from "./web-api.js";

/** The decision and alert events Slack shows at the top level of the room's channel. */
export const NEWS_EVENT_KINDS: readonly EventKind[] = [
  "decision.posted",
  "decision.acked",
  "alert.raised",
  "alert.confirmed",
  "alert.resolved",
];

const SKIP: EventOutcome = { kind: "done", posted: 0 };

/** Confirmed and still open: the only state in which an alert card carries `<!here>`. */
const isLoud = (a: Alert) => a.level === "confirmed" && a.resolvedAt === null;

/**
 * Decisions and alerts post at the top level, once each, and later events edit or reply to that
 * one message. A channel is pinged at most once per alert (`loud`), never by an edit, and never
 * for an alert that is resolved by the time it would be.
 */
export async function postNewsEvent(o: OutboundOptions, e: BoardEvent): Promise<EventOutcome> {
  const settings = await slackRoomSettings(o.db, e.room);
  if (settings.channel === null || settings.announce === "none") return SKIP;
  const id = entityIdOf(e);
  if (id === null) return SKIP;
  const kind: SlackPostRow["kind"] = e.kind.startsWith("decision.") ? "decision" : "alert";

  const send = async (method: SlackMethod, channel: string, body: Record<string, unknown>) => {
    const r = await callSlack(o.slack, method, { channel, ...body });
    if (r.kind === "permanent") {
      o.log?.(`slack-outbound: dropped the ${e.kind} ${method} for ${kind} ${id} to ${channel}: ${r.reason}`);
    }
    return r;
  };
  /** Posts a card at the top level and saves it as this decision's or alert's message. */
  const postTop = async (message: { blocks: unknown[]; text: string }, loud: boolean): Promise<EventOutcome> => {
    const channel = settings.channel!;
    const r = await send("chat.postMessage", channel, message);
    if (r.kind === "retry") return r;
    if (r.kind === "permanent") return SKIP;
    if (r.ts === null) {
      o.log?.(`slack-outbound: dropped the ${e.kind} post for ${kind} ${id} to ${channel}: slack error no_ts`);
      return SKIP;
    }
    await saveSlackPost(o.db, { kind, refId: id, channel, ts: r.ts, loud });
    return { kind: "done", posted: 1 };
  };
  /** Edits the saved message in place; an edit never pings anyone. */
  const edit = async (post: SlackPostRow, message: { blocks: unknown[]; text: string }): Promise<EventOutcome> => {
    const r = await send("chat.update", post.channel, { ts: post.ts, ...message });
    if (r.kind === "retry") return r;
    return r.kind === "ok" ? { kind: "done", posted: 1 } : SKIP;
  };

  const post = await getSlackPost(o.db, kind, id);
  if (kind === "decision") {
    const decision = await loadDecision(o.db, id);
    if (!decision) return SKIP;
    const card = toSlackMessage(DecisionCard({ decision }));
    if (e.kind === "decision.posted") return post ? SKIP : postTop(card, false);
    return post ? edit(post, card) : SKIP; // decision.acked
  }

  const alert = await loadAlert(o.db, id);
  if (!alert) return SKIP;
  const card = toSlackMessage(AlertCard({ alert }));
  switch (e.kind) {
    case "alert.raised":
      return post ? SKIP : postTop(card, isLoud(alert));
    case "alert.confirmed": {
      if (alert.resolvedAt !== null) return SKIP; // a resolved alert never pings
      if (!post) return postTop(card, isLoud(alert));
      if (post.loud) return SKIP;
      const r = await send("chat.postMessage", post.channel, { thread_ts: post.ts, reply_broadcast: true, text: alertConfirmedLine(alert) });
      if (r.kind === "retry") return r;
      if (r.kind === "permanent") return SKIP;
      await saveSlackPost(o.db, { ...post, loud: true });
      return { kind: "done", posted: 1 };
    }
    case "alert.resolved":
      return post ? edit(post, card) : SKIP;
    default:
      return SKIP;
  }
}

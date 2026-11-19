import type { Q } from "../db/pool.js";

export interface SlackThreadRow {
  taskId: string;
  channel: string | null;
  ts: string | null;
  conversationKey: string | null;
}

export type SlackAnnounce = "blocked" | "all" | "none";

function toRow(r: Record<string, unknown>): SlackThreadRow {
  return {
    taskId: r.thread_id as string,
    channel: (r.channel as string | null) ?? null,
    ts: (r.ts as string | null) ?? null,
    conversationKey: (r.conversation_key as string | null) ?? null,
  };
}

export async function getSlackThread(q: Q, taskId: string): Promise<SlackThreadRow | null> {
  const [r] = await q`select * from slack_threads where thread_id = ${taskId}`;
  return r ? toRow(r) : null;
}

export async function findTaskByConversation(q: Q, key: string): Promise<string | null> {
  const [r] = await q`select thread_id from slack_threads where conversation_key = ${key}`;
  return r ? (r.thread_id as string) : null;
}

/** Upsert by task id. A null column in `row` keeps whatever is already stored. */
export async function saveSlackThread(q: Q, row: SlackThreadRow): Promise<SlackThreadRow> {
  const [r] = await q`
    insert into slack_threads (thread_id, channel, ts, conversation_key)
    values (${row.taskId}, ${row.channel}, ${row.ts}, ${row.conversationKey})
    on conflict (thread_id) do update set
      channel = coalesce(excluded.channel, slack_threads.channel),
      ts = coalesce(excluded.ts, slack_threads.ts),
      conversation_key = coalesce(excluded.conversation_key, slack_threads.conversation_key)
    returning *`;
  if (!r) throw new Error("saveSlackThread: row missing");
  return toRow(r);
}

/** The conversation key the native Slack adapter uses for a thread. */
export function nativeConversationKey(channel: string, ts: string): string {
  return `${channel}::${ts}`;
}

/** The first room (by name) mapped to a Slack channel, or null. */
export async function roomForSlackChannel(q: Q, channel: string): Promise<string | null> {
  const [r] = await q`select name from rooms where slack_channel = ${channel} order by name limit 1`;
  return r ? (r.name as string) : null;
}

export async function slackRoomSettings(
  q: Q,
  room: string,
): Promise<{ channel: string | null; announce: SlackAnnounce }> {
  const [r] = await q`select slack_channel, slack_announce from rooms where name = ${room}`;
  return {
    channel: (r?.slack_channel as string | null) ?? null,
    announce: (r?.slack_announce as SlackAnnounce | undefined) ?? "blocked",
  };
}

export async function getServiceCursor(q: Q, name: string): Promise<string | null> {
  const [r] = await q`select cursor from service_cursors where name = ${name}`;
  return r ? String(r.cursor) : null;
}

/** Cursors only move forward: a lower value is ignored. */
export async function setServiceCursor(q: Q, name: string, cursor: string): Promise<void> {
  await q`
    insert into service_cursors (name, cursor) values (${name}, ${cursor}::bigint)
    on conflict (name) do update set
      cursor = greatest(service_cursors.cursor, excluded.cursor),
      updated_at = now()`;
}

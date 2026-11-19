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

/**
 * The task mirrored at a Slack thread's coordinates, for a turn whose conversation key is not
 * stored yet: a thread Slack outbound started has channel and ts but no key, since the managed
 * Channel's key is not known until the first turn arrives from it. A row with no key gets this
 * key, so later turns match on it directly; a key that is already stored is never replaced.
 */
export async function findTaskByCoordinates(
  q: Q,
  coordinates: { channel: string; ts: string },
  conversationKey: string,
): Promise<string | null> {
  const [r] = await q`
    select thread_id, conversation_key from slack_threads
    where channel = ${coordinates.channel} and ts = ${coordinates.ts}`;
  if (!r) return null;
  const taskId = r.thread_id as string;
  if (r.conversation_key === null) {
    try {
      await q`
        update slack_threads set conversation_key = ${conversationKey}
        where thread_id = ${taskId} and conversation_key is null
          and not exists (select 1 from slack_threads where conversation_key = ${conversationKey})`;
    } catch (e) {
      // Another turn stored this key for some row between the check and the write: keep that one.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return taskId;
}

/** Postgres unique_violation. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
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

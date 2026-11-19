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

/** The pinned status message for a room linked to Slack. `editedAt` is epoch ms. */
export interface StatusMessageRow {
  room: string;
  channel: string;
  ts: string;
  pinned: boolean;
  bodyHash: string;
  editedAt: number;
}

export async function getStatusMessage(q: Q, room: string): Promise<StatusMessageRow | null> {
  const [r] = await q`select room, channel, ts, pinned, body_hash, edited_at from slack_status_messages where room = ${room}`;
  if (!r) return null;
  return {
    room: r.room as string,
    channel: r.channel as string,
    ts: r.ts as string,
    pinned: r.pinned as boolean,
    bodyHash: r.body_hash as string,
    editedAt: (r.edited_at as Date).getTime(),
  };
}

/** Upserts the room's status message. */
export async function saveStatusMessage(q: Q, row: StatusMessageRow): Promise<void> {
  await q`
    insert into slack_status_messages (room, channel, ts, pinned, body_hash, edited_at)
    values (${row.room}, ${row.channel}, ${row.ts}, ${row.pinned}, ${row.bodyHash}, ${new Date(row.editedAt)})
    on conflict (room) do update set
      channel = excluded.channel, ts = excluded.ts, pinned = excluded.pinned,
      body_hash = excluded.body_hash, edited_at = excluded.edited_at`;
}

/** The top-level Slack message for a decision or an alert. */
export interface SlackPostRow {
  kind: "decision" | "alert";
  refId: string;
  channel: string;
  ts: string;
  loud: boolean;
}

export async function getSlackPost(q: Q, kind: SlackPostRow["kind"], refId: string): Promise<SlackPostRow | null> {
  const [r] = await q`select kind, ref_id, channel, ts, loud from slack_posts where kind = ${kind} and ref_id = ${refId}`;
  if (!r) return null;
  return { kind: r.kind as SlackPostRow["kind"], refId: r.ref_id as string, channel: r.channel as string, ts: r.ts as string, loud: r.loud as boolean };
}

/** Upserts a post. `loud` never goes from true back to false: a channel is pinged at most once. */
export async function saveSlackPost(q: Q, row: SlackPostRow): Promise<void> {
  await q`
    insert into slack_posts (kind, ref_id, channel, ts, loud)
    values (${row.kind}, ${row.refId}, ${row.channel}, ${row.ts}, ${row.loud})
    on conflict (kind, ref_id) do update set
      channel = excluded.channel, ts = excluded.ts, loud = slack_posts.loud or excluded.loud`;
}

/** A room that posts to a Slack channel. */
export interface LinkedRoom {
  room: string;
  channel: string;
  announce: "blocked" | "all";
  approvers: string[] | null;
}

/** Rooms with a Slack channel whose announce mode is not `none`, by name. */
export async function linkedRooms(q: Q): Promise<LinkedRoom[]> {
  const rows = await q`
    select name, slack_channel, slack_announce, approvers from rooms
    where slack_channel is not null and slack_announce <> 'none'
    order by name`;
  return rows.map((r) => ({
    room: r.name as string,
    channel: r.slack_channel as string,
    announce: r.slack_announce as LinkedRoom["announce"],
    approvers: (r.approvers as string[] | null) ?? null,
  }));
}

/** The Slack user most recently linked to the person named `personName`, or null. */
export async function slackUserOf(q: Q, personName: string): Promise<string | null> {
  const [r] = await q`
    select l.slack_user_id from slack_links l join actors a on a.id = l.actor_id
    where a.name = ${personName} and a.kind = 'person'
    order by l.created_at desc limit 1`;
  return r ? (r.slack_user_id as string) : null;
}

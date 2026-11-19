import { createHash } from "node:crypto";
import type { Db, Q } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { getRoomInfo } from "../store/rooms.js";
import { loadTasks } from "../store/task-load.js";
import { toSlackMessage } from "./blocks.js";
import { StatusCard, type RoomStatus } from "./cards.js";
import { agentsOn, waitsOn } from "./coordination.js";
import { getStatusMessage, linkedRooms, saveStatusMessage } from "./mirror.js";
import { startPassLoop } from "./pass-loop.js";
import { callSlack, type SlackApi } from "./web-api.js";

/** A room's status message is edited at most once per this long. */
export const STATUS_MIN_EDIT_GAP_MS = 10_000;
/** Presence is polled, not an event: a tick this often notices agents that went quiet. */
export const STATUS_TICK_MS = 5_000;
/** Claimed tasks and asks listed by name; the rest are counted. */
export const STATUS_LIST_MAX = 10;
/** A channel TeamKit cannot post in is tried again only after this long. */
export const STATUS_FAILED_RETRY_MS = 600_000;

const OPEN_STATES = ["ready", "waiting", "claimed", "blocked"] as const;

/** What the status message shows for one room at `now`. */
export async function roomStatus(q: Q, room: string, publicUrl: string, now: number): Promise<RoomStatus> {
  const base = publicUrl.replace(/\/+$/, "");
  const rows = await q`
    select t.thread_id from tasks t join threads th on th.id = t.thread_id
    where th.room = ${room} and t.state in ${q(OPEN_STATES as unknown as string[])}
    order by th.created_at, t.thread_id`;
  const tasks = await loadTasks(q, rows.map((r) => r.thread_id as string));
  const approvers = (await getRoomInfo(q, room))?.approvers ?? null;
  const counts = { ready: 0, waiting: 0, claimed: 0, blocked: 0 };
  for (const t of tasks) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  const claimed = tasks.filter((t) => t.state === "claimed");
  const blocked = tasks.filter((t) => t.state === "blocked" && t.block);
  return {
    room,
    roomUrl: `${base}/?room=${encodeURIComponent(room)}`,
    agentsOn: await agentsOn(q, room, now),
    working: claimed.slice(0, STATUS_LIST_MAX).map((t) => ({
      taskId: t.id,
      brief: t.brief,
      by: t.claim?.actor.name ?? "someone",
      url: `${base}/t/${t.id}`,
    })),
    asks: blocked.slice(0, STATUS_LIST_MAX).map((t) => ({
      taskId: t.id,
      question: t.block!.question,
      waitsOn: waitsOn(t.block!, approvers),
      url: `${base}/t/${t.id}`,
    })),
    moreWorking: Math.max(0, claimed.length - STATUS_LIST_MAX),
    moreAsks: Math.max(0, blocked.length - STATUS_LIST_MAX),
    counts,
  };
}

/** A sha256 of the status, so an unchanged status is never sent again. */
export function statusHash(s: RoomStatus): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex");
}

export interface StatusOptions {
  db: Db;
  notifier: Notifier;
  slack: SlackApi;
  publicUrl: string;
  minEditGapMs?: number;
  tickMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Rooms whose channel refused a status post, and until when they are left alone. */
export interface StatusMemory {
  failed: Map<string, { channel: string; until: number }>;
}

export interface StatusPass {
  posted: number;
  edited: number;
  retry: { reason: string; afterMs: number | null } | null;
}

/**
 * One pass over the rooms linked to Slack: each room's pinned status message is edited in place
 * when what it shows changed, at most once per `minEditGapMs`. A message that was deleted (or
 * cannot be edited) is posted again and pinned. A channel that refuses the post is logged and left
 * alone for STATUS_FAILED_RETRY_MS. A retry from Slack ends the pass.
 */
export async function processStatusOnce(o: StatusOptions, memory: StatusMemory = { failed: new Map() }): Promise<StatusPass> {
  const now = o.now?.() ?? Date.now();
  const gap = o.minEditGapMs ?? STATUS_MIN_EDIT_GAP_MS;
  let posted = 0;
  let edited = 0;
  const cannotPost = (room: string, channel: string, reason: string) => {
    o.log?.(`slack-status: cannot post the status for ${room} in ${channel}: ${reason}`);
    memory.failed.set(room, { channel, until: now + STATUS_FAILED_RETRY_MS });
  };

  for (const { room, channel } of await linkedRooms(o.db)) {
    const failed = memory.failed.get(room);
    if (failed && failed.channel === channel && now < failed.until) continue;
    const status = await roomStatus(o.db, room, o.publicUrl, now);
    const hash = statusHash(status);
    const row = await getStatusMessage(o.db, room);
    const here = row !== null && row.channel === channel;
    if (here && row.bodyHash === hash) continue;
    if (here && now - row.editedAt < gap) continue; // the next tick or event picks it up again
    const message = toSlackMessage(StatusCard({ status, changedAt: now }));

    if (here) {
      const r = await callSlack(o.slack, "chat.update", { channel, ts: row.ts, ...message });
      if (r.kind === "retry") return { posted, edited, retry: { reason: r.reason, afterMs: r.afterMs } };
      if (r.kind === "ok") {
        await saveStatusMessage(o.db, { ...row, bodyHash: hash, editedAt: now });
        edited++;
        continue;
      }
      // A person deleted the message, or it can no longer be edited: post a fresh one below.
      if (r.error !== "message_not_found" && r.error !== "cant_update_message") {
        cannotPost(room, channel, r.reason);
        continue;
      }
    }

    const p = await callSlack(o.slack, "chat.postMessage", { channel, ...message });
    if (p.kind === "retry") return { posted, edited, retry: { reason: p.reason, afterMs: p.afterMs } };
    if (p.kind === "permanent") {
      cannotPost(room, channel, p.reason);
      continue;
    }
    if (p.ts === null) {
      cannotPost(room, channel, "slack error no_ts");
      continue;
    }
    posted++;
    const pin = await callSlack(o.slack, "pins.add", { channel, timestamp: p.ts });
    const pinned = pin.kind === "ok" || (pin.kind === "permanent" && pin.error === "already_pinned");
    // Saved before any retry, so a retried pass edits this message instead of posting another.
    await saveStatusMessage(o.db, { room, channel, ts: p.ts, pinned, bodyHash: hash, editedAt: now });
    if (pin.kind === "retry") return { posted, edited, retry: { reason: pin.reason, afterMs: pin.afterMs } };
    if (!pinned) o.log?.(`slack-status: posted the status for ${room} but could not pin it: ${pin.reason}`);
  }
  return { posted, edited, retry: null };
}

/** Keeps every linked room's status message current: on each board event and every tick. */
export async function startSlackStatus(o: StatusOptions): Promise<{ stop(): Promise<void> }> {
  const memory: StatusMemory = { failed: new Map() };
  return startPassLoop({
    label: "slack-status",
    notifier: o.notifier,
    pollMs: o.tickMs ?? STATUS_TICK_MS,
    ...(o.maxBackoffMs === undefined ? {} : { maxBackoffMs: o.maxBackoffMs }),
    ...(o.log === undefined ? {} : { log: o.log }),
    pass: () => processStatusOnce(o, memory),
  });
}

import { BoardError, ID_PREFIXES, custom, newId, type ActorRef, type Alert, type AlertLevel } from "@copilotkit/teamkit-protocol";
import type { Db, Q, Tx } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { assertRoomName, assertShort, listLimit, onBehalfOf, openItemThread } from "./coord-rows.js";
import { appendEvent } from "./events.js";

const MAX_ALERT_LENGTH = 2000;

const ref = (id: unknown, name: unknown, kind: unknown): ActorRef => ({
  id: id as string,
  name: name as string,
  kind: kind as ActorRef["kind"],
});
const optRef = (id: unknown, name: unknown, kind: unknown): ActorRef | null => (id ? ref(id, name, kind) : null);

/** Alerts by id, in the order of `ids`; unknown ids are skipped. */
export async function loadAlerts(q: Q, ids: string[]): Promise<Alert[]> {
  if (ids.length === 0) return [];
  const rows = await q`
    select l.id, l.room, l.thread_id, l.text, l.level, l.resolved_at, l.created_at,
           rb.id as rb_id, rb.name as rb_name, rb.kind as rb_kind,
           cb.id as cb_id, cb.name as cb_name, cb.kind as cb_kind,
           sr.id as sr_id, sr.name as sr_name, sr.kind as sr_kind,
           xb.id as xb_id, xb.name as xb_name, xb.kind as xb_kind,
           xs.id as xs_id, xs.name as xs_name, xs.kind as xs_kind
    from alerts l
    join actors rb on rb.id = l.raised_by
    left join actors cb on cb.id = l.confirmed_by
    left join actors sr on sr.id = l.source
    left join actors xb on xb.id = l.resolved_by
    left join actors xs on xs.id = l.resolved_source
    where l.id = any(${ids})`;
  const byId = new Map<string, Alert>();
  for (const r of rows) {
    byId.set(r.id as string, {
      id: r.id as string,
      room: r.room as string,
      threadId: r.thread_id as string,
      text: r.text as string,
      level: r.level as AlertLevel,
      raisedBy: ref(r.rb_id, r.rb_name, r.rb_kind),
      confirmedBy: optRef(r.cb_id, r.cb_name, r.cb_kind),
      source: optRef(r.sr_id, r.sr_name, r.sr_kind),
      resolvedBy: optRef(r.xb_id, r.xb_name, r.xb_kind),
      resolvedSource: optRef(r.xs_id, r.xs_name, r.xs_kind),
      resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
      createdAt: (r.created_at as Date).toISOString(),
    });
  }
  return ids.map((id) => byId.get(id)).filter((a): a is Alert => a !== undefined);
}

/** Raises an alert. Any member who can post raises one; every new alert is only suspected. */
export async function raiseAlert(db: Db, auth: AuthContext, input: { room: string; text: string }): Promise<Alert> {
  const room = assertRoomName(input.room);
  const text = assertShort("text", input.text, MAX_ALERT_LENGTH, { required: true })!;
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "post");
    const thread = await openItemThread(tx, auth, room, `Alert (suspected): ${text}`);
    const alertId = newId(ID_PREFIXES.alert);
    await tx`
      insert into alerts (id, room, thread_id, text, raised_by)
      values (${alertId}, ${room}, ${thread.threadId}, ${text}, ${auth.actor.id})`;
    await appendEvent(tx, {
      kind: "alert.raised",
      room,
      threadId: thread.threadId,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.alert.raised", { alertId, room, text, level: "suspected", raisedBy: auth.actor }),
        ...thread.agui,
      ],
      data: { alertId, level: "suspected", messageId: thread.messageId },
    });
    return (await loadAlerts(tx, [alertId]))[0]!;
  });
}

/** Locks the alert, checks `post` in its room, and returns it. */
async function lockAlert(tx: Tx, auth: AuthContext, id: string): Promise<Alert> {
  const [row] = await tx`select id from alerts where id = ${id} for update`;
  if (!row) throw new BoardError("not_found", `alert ${id} not found`);
  const alert = (await loadAlerts(tx, [id]))[0]!;
  await requirePerm(tx, auth, alert.room, "post");
  return alert;
}

/** Confirms a suspected alert for a person: the caller themselves, or an agent's owner named as the source. */
export async function confirmAlert(db: Db, auth: AuthContext, id: string, input: { source?: string }): Promise<Alert> {
  return db.begin(async (tx) => {
    const alert = await lockAlert(tx, auth, id);
    if (alert.resolvedBy) throw new BoardError("invalid_state", `alert ${id} was resolved by ${alert.resolvedBy.name}`);
    if (alert.level === "confirmed") {
      throw new BoardError("invalid_state", `alert ${id} was already confirmed by ${alert.confirmedBy?.name ?? "someone"}`);
    }
    const source = await onBehalfOf(tx, auth, input.source, "confirm an alert");
    await tx`
      update alerts set level = 'confirmed', confirmed_by = ${auth.actor.id}, source = ${source.id},
        confirmed_at = clock_timestamp()
      where id = ${id}`;
    await appendEvent(tx, {
      kind: "alert.confirmed",
      room: alert.room,
      threadId: alert.threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.alert.confirmed", { alertId: id, by: auth.actor, source })],
      data: { alertId: id, level: "confirmed", source },
    });
    return (await loadAlerts(tx, [id]))[0]!;
  });
}

/**
 * Resolves an alert, confirmed or still suspected (a false alarm), for a person. Its level is kept;
 * `resolvedBy` is the caller and `resolvedSource` the person it was resolved for.
 */
export async function resolveAlert(db: Db, auth: AuthContext, id: string, input: { source?: string }): Promise<Alert> {
  return db.begin(async (tx) => {
    const alert = await lockAlert(tx, auth, id);
    if (alert.resolvedBy) throw new BoardError("invalid_state", `alert ${id} was already resolved by ${alert.resolvedBy.name}`);
    const source = await onBehalfOf(tx, auth, input.source, "resolve an alert");
    await tx`
      update alerts set resolved_by = ${auth.actor.id}, resolved_source = ${source.id}, resolved_at = clock_timestamp()
      where id = ${id}`;
    await appendEvent(tx, {
      kind: "alert.resolved",
      room: alert.room,
      threadId: alert.threadId,
      actorId: auth.actor.id,
      agui: [custom("teamkit.alert.resolved", { alertId: id, by: auth.actor, source })],
      data: { alertId: id, source },
    });
    return (await loadAlerts(tx, [id]))[0]!;
  });
}

/** The room's alerts, newest first; `open: true` leaves out resolved ones. */
export async function listAlerts(
  db: Db,
  auth: AuthContext,
  room: string,
  opts?: { open?: boolean; limit?: number },
): Promise<Alert[]> {
  const limit = listLimit(opts?.limit);
  assertRoomName(room);
  await requirePerm(db, auth, room, "read");
  const rows = await db`
    select id from alerts
    where room = ${room} ${opts?.open ? db`and resolved_at is null` : db``}
    order by created_at desc, id desc limit ${limit}`;
  return loadAlerts(db, rows.map((r) => r.id as string));
}

import {
  BoardError,
  ID_PREFIXES,
  custom,
  newId,
  runError,
  runFinishedSuccess,
  runStarted,
  LEASE_MS_DEFAULT,
  type Claim,
  type Task,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q, Tx } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { appendEvent } from "./events.js";
import { assertText } from "./rows.js";
import { loadTask } from "./task-load.js";
import { withRetry } from "./tx.js";

/** Lease length in ms. Read at call time so tests can change TEAMKIT_LEASE_MS. */
export function leaseMs(): number {
  const raw = process.env.TEAMKIT_LEASE_MS;
  if (raw === undefined || raw === "") return LEASE_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : LEASE_MS_DEFAULT;
}

async function mustLoad(q: Q, taskId: string): Promise<Task> {
  const task = await loadTask(q, taskId);
  if (!task) throw new Error(`task ${taskId} vanished`);
  return task;
}

/** Locks the task row and checks that this actor still holds this claim. */
export async function lockClaim(tx: Tx, auth: AuthContext, taskId: string, claimId: string): Promise<Task> {
  const task = await loadTask(tx, taskId, { forUpdate: true });
  if (!task) throw new BoardError("not_found", `task ${taskId} not found`);
  if (task.state !== "claimed" || task.claim?.id !== claimId || task.claim.actor.id !== auth.actor.id) {
    throw new BoardError("claim_lost", `claim ${claimId} on ${taskId} is no longer held by ${auth.actor.name}`);
  }
  return task;
}

/** Atomic ready -> claimed. Returns false when the task was not ready. */
async function takeClaim(tx: Tx, auth: AuthContext, taskId: string, claimId: string): Promise<boolean> {
  const ms = leaseMs();
  const rows = await tx`
    update tasks
    set state = 'claimed', claim_id = ${claimId}, claimed_by = ${auth.actor.id},
        lease_expires_at = now() + (${ms}::double precision / 1000) * interval '1 second',
        updated_at = now()
    where thread_id = ${taskId} and state = 'ready'
    returning thread_id`;
  return rows.length === 1;
}

async function claimedEvent(
  tx: Tx,
  auth: AuthContext,
  taskId: string,
  claimId: string,
  opensRun: boolean,
): Promise<Claim> {
  const task = await mustLoad(tx, taskId);
  const leaseExpiresAt = task.claim!.leaseExpiresAt;
  await appendEvent(tx, {
    kind: "task.claimed",
    room: task.room,
    threadId: taskId,
    actorId: auth.actor.id,
    agui: [
      custom("teamkit.task.claimed", { claimId, actor: auth.actor }),
      ...(opensRun ? [runStarted(taskId, claimId, claimId)] : []),
    ],
    data: { taskId, state: "claimed", claimId, leaseExpiresAt },
  });
  return { task, claimId, leaseExpiresAt };
}

export async function claimTask(
  db: Db,
  auth: AuthContext,
  taskId: string,
  opts?: { opensRun?: boolean },
): Promise<Claim> {
  return db.begin(async (tx) => {
    const existing = await loadTask(tx, taskId);
    if (!existing) throw new BoardError("not_found", `task ${taskId} not found`);
    await requirePerm(tx, auth, existing.room, "claim");
    const claimId = newId(ID_PREFIXES.claim);
    if (!(await takeClaim(tx, auth, taskId, claimId))) {
      const now = await loadTask(tx, taskId);
      if (now?.state === "claimed") throw new BoardError("task_claimed", `task ${taskId} is already claimed`);
      throw new BoardError("invalid_state", `task ${taskId} is ${now?.state ?? "gone"}, not ready`);
    }
    return claimedEvent(tx, auth, taskId, claimId, opts?.opensRun !== false);
  });
}

function roomFilter(q: Q, room: string) {
  if (room === "*") return q``;
  if (room.endsWith("/")) {
    const base = room.slice(0, -1);
    const like = `${base.replace(/[\\%_]/g, "\\$&")}/%`;
    return q`and (th.room = ${base} or th.room like ${like})`;
  }
  return q`and th.room = ${room}`;
}

export async function claimNext(
  db: Db,
  auth: AuthContext,
  input: { room: string; labels?: Record<string, string>; opensRun?: boolean },
): Promise<Claim | null> {
  const labels = input.labels ?? {};
  // Checked before the person shortcut below: an admin-scope token holds no board permission.
  if (auth.scope === "admin") {
    throw new BoardError("forbidden", `${auth.actor.name} uses an admin token, which cannot claim in ${input.room}`);
  }
  return db.begin(async (tx) => {
    const grantCheck =
      auth.actor.kind === "person"
        ? tx``
        : tx`and exists (
            select 1 from grants g
            where g.actor_id = ${auth.actor.id} and 'claim' = any(g.perms)
              and (g.room_pattern = '*' or g.room_pattern = th.room
                   or (right(g.room_pattern, 1) = '/'
                       and (th.room = left(g.room_pattern, -1) or th.room like g.room_pattern || '%'))))`;
    const [row] = await tx<{ thread_id: string }[]>`
      select t.thread_id
      from tasks t join threads th on th.id = t.thread_id
      where t.state = 'ready'
        ${roomFilter(tx, input.room)}
        and th.labels @> ${tx.json(labels)}
        ${grantCheck}
      order by th.created_at, t.thread_id
      for update of t skip locked
      limit 1`;
    if (!row) return null;
    const claimId = newId(ID_PREFIXES.claim);
    if (!(await takeClaim(tx, auth, row.thread_id, claimId))) {
      throw new Error(`task ${row.thread_id} was locked but not ready`);
    }
    return claimedEvent(tx, auth, row.thread_id, claimId, input.opensRun !== false);
  });
}

export async function renew(
  db: Db,
  auth: AuthContext,
  taskId: string,
  claimId: string,
): Promise<{ leaseExpiresAt: string }> {
  return db.begin(async (tx) => {
    await lockClaim(tx, auth, taskId, claimId);
    const ms = leaseMs();
    const [row] = await tx<{ lease_expires_at: Date }[]>`
      update tasks
      set lease_expires_at = now() + (${ms}::double precision / 1000) * interval '1 second', updated_at = now()
      where thread_id = ${taskId}
      returning lease_expires_at`;
    return { leaseExpiresAt: row!.lease_expires_at.toISOString() };
  });
}

export async function release(db: Db, auth: AuthContext, taskId: string, claimId: string): Promise<Task> {
  return db.begin(async (tx) => {
    const task = await lockClaim(tx, auth, taskId, claimId);
    await tx`
      update tasks
      set state = 'ready', claim_id = null, claimed_by = null, lease_expires_at = null, updated_at = now()
      where thread_id = ${taskId}`;
    await appendEvent(tx, {
      kind: "task.released",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [runError("released", "teamkit.released")],
      data: { taskId, state: "ready", claimId },
    });
    return mustLoad(tx, taskId);
  });
}

export async function complete(
  db: Db,
  auth: AuthContext,
  taskId: string,
  claimId: string,
  result: string | null,
): Promise<Task> {
  const text = assertText("result", result) ?? null;
  // Locks the task, then its waiting dependents: a createTask holding one of those
  // dependents FOR SHARE while waiting on this task is a deadlock, so retry.
  return withRetry(db, async (tx) => {
    const task = await lockClaim(tx, auth, taskId, claimId);
    await tx`
      update tasks
      set state = 'completed', result = ${text}, claim_id = null, claimed_by = null,
          lease_expires_at = null, pending_resume = null, updated_at = now()
      where thread_id = ${taskId}`;
    // Lock the waiting dependents first (in id order), then promote in a fresh
    // statement. Two needs of one dependent can complete at the same moment; the
    // second to get the lock must see the first one's committed completion, and an
    // update's own snapshot would not.
    await tx`
      select thread_id from tasks
      where state = 'waiting' and thread_id in (select task_id from task_needs where needs_id = ${taskId})
      order by thread_id for update`;
    const promoted = await tx<{ thread_id: string; room: string }[]>`
      with up as (
        update tasks t set state = 'ready', updated_at = now()
        where t.state = 'waiting'
          and t.thread_id in (select task_id from task_needs where needs_id = ${taskId})
          and not exists (
            select 1 from task_needs n join tasks d on d.thread_id = n.needs_id
            where n.task_id = t.thread_id and d.state <> 'completed')
        returning t.thread_id)
      select up.thread_id, th.room from up join threads th on th.id = up.thread_id
      order by up.thread_id`;
    await appendEvent(tx, {
      kind: "task.completed",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [runFinishedSuccess(taskId, claimId, text)],
      data: { taskId, state: "completed", claimId },
    });
    for (const p of promoted) {
      await appendEvent(tx, {
        kind: "task.ready",
        room: p.room,
        threadId: p.thread_id,
        actorId: auth.actor.id,
        agui: [custom("teamkit.task.ready", { reason: "dependencies_met" })],
        data: { taskId: p.thread_id, state: "ready", reason: "dependencies_met" },
      });
    }
    return mustLoad(tx, taskId);
  });
}

export async function fail(
  db: Db,
  auth: AuthContext,
  taskId: string,
  claimId: string,
  reason: string,
): Promise<Task> {
  const why = assertText("reason", reason, { required: true }) as string;
  return db.begin(async (tx) => {
    const task = await lockClaim(tx, auth, taskId, claimId);
    await tx`
      update tasks
      set state = 'failed', claim_id = null, claimed_by = null,
          lease_expires_at = null, pending_resume = null, updated_at = now()
      where thread_id = ${taskId}`;
    await appendEvent(tx, {
      kind: "task.failed",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [runError(why, "teamkit.failed")],
      data: { taskId, state: "failed", claimId, reason: why },
    });
    return mustLoad(tx, taskId);
  });
}

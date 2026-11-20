import type { ActorRef, PendingResume, Task, TaskBlock, TaskState } from "@copilotkit/teamkit-protocol";
import type { Q, Tx } from "../db/pool.js";

type Row = {
  thread_id: string;
  room: string;
  labels: Record<string, string>;
  created_at: Date;
  created_by: string;
  created_by_name: string;
  created_by_kind: "agent" | "person";
  state: TaskState;
  brief: string;
  target: string | null;
  claim_id: string | null;
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_by_kind: "agent" | "person" | null;
  lease_expires_at: Date | null;
  block: (Omit<TaskBlock, "approvers"> & { approvers?: string[] | null }) | null;
  reserved_for: string | null;
  reserved_for_name: string | null;
  reserved_for_kind: "agent" | "person" | null;
  reserved_until: Date | null;
  pending_resume: PendingResume[] | null;
  result: string | null;
  attempts: number;
  updated_at: Date;
};

async function fetchRows(q: Q, ids: string[]): Promise<Row[]> {
  return q<Row[]>`
    select t.thread_id, th.room, th.labels, th.created_at,
           th.created_by, cb.name as created_by_name, cb.kind as created_by_kind,
           t.state, t.brief, t.target, t.claim_id,
           t.claimed_by, cl.name as claimed_by_name, cl.kind as claimed_by_kind,
           t.lease_expires_at, t.block, t.pending_resume, t.result, t.attempts, t.updated_at,
           t.reserved_for, rf.name as reserved_for_name, rf.kind as reserved_for_kind, t.reserved_until
    from tasks t
    join threads th on th.id = t.thread_id
    join actors cb on cb.id = th.created_by
    left join actors cl on cl.id = t.claimed_by
    left join actors rf on rf.id = t.reserved_for
    where t.thread_id in ${q(ids)}`;
}

async function hydrate(q: Q, rows: Row[]): Promise<Map<string, Task>> {
  const out = new Map<string, Task>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.thread_id);
  const needRows = await q<{ task_id: string; needs_id: string; state: TaskState }[]>`
    select n.task_id, n.needs_id, d.state
    from task_needs n join tasks d on d.thread_id = n.needs_id
    where n.task_id in ${q(ids)}
    order by n.needs_id`;
  const needs = new Map<string, { ids: string[]; states: Record<string, TaskState> }>();
  for (const n of needRows) {
    let e = needs.get(n.task_id);
    if (!e) needs.set(n.task_id, (e = { ids: [], states: {} }));
    e.ids.push(n.needs_id);
    e.states[n.needs_id] = n.state;
  }
  for (const r of rows) {
    const createdBy: ActorRef = { id: r.created_by, name: r.created_by_name, kind: r.created_by_kind };
    const claim =
      r.claim_id && r.claimed_by && r.lease_expires_at
        ? {
            id: r.claim_id,
            actor: { id: r.claimed_by, name: r.claimed_by_name!, kind: r.claimed_by_kind! } as ActorRef,
            leaseExpiresAt: r.lease_expires_at.toISOString(),
          }
        : null;
    const n = needs.get(r.thread_id);
    out.set(r.thread_id, {
      id: r.thread_id,
      room: r.room,
      state: r.state,
      brief: r.brief,
      labels: r.labels,
      needs: n ? [...n.ids].sort() : [],
      needStates: n ? n.states : {},
      target: r.target,
      claim,
      // A block stored before named approvers has no approvers key: it reads as null.
      block: r.block ? { ...r.block, approvers: r.block.approvers ?? null } : null,
      pendingResume: r.pending_resume ?? null,
      reservedFor:
        r.reserved_for && r.reserved_for_name && r.reserved_for_kind
          ? { id: r.reserved_for, name: r.reserved_for_name, kind: r.reserved_for_kind }
          : null,
      reservedUntil: r.reserved_until ? r.reserved_until.toISOString() : null,
      attempts: r.attempts,
      result: r.result,
      createdBy,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    });
  }
  return out;
}

export async function loadTasks(q: Q, ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const map = await hydrate(q, await fetchRows(q, ids));
  return ids.flatMap((id) => {
    const t = map.get(id);
    return t ? [t] : [];
  });
}

export async function loadTask(q: Q, taskId: string, opts?: { forUpdate?: false }): Promise<Task | null>;
/** Locks the task row FOR UPDATE until the transaction ends, then loads it; the lock needs a transaction. */
export async function loadTask(tx: Tx, taskId: string, opts: { forUpdate: true }): Promise<Task | null>;
export async function loadTask(q: Q, taskId: string, opts?: { forUpdate?: boolean }): Promise<Task | null> {
  if (opts?.forUpdate) {
    const locked = await q`select thread_id from tasks where thread_id = ${taskId} for update`;
    if (locked.length === 0) return null;
  }
  return (await loadTasks(q, [taskId]))[0] ?? null;
}

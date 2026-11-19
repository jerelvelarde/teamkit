import { custom, runError } from "@copilotkit/teamkit-protocol";
import type { Db, Tx } from "../db/pool.js";
import { appendEvent } from "./events.js";

interface ReapedRow {
  thread_id: string;
  room: string;
  claim_id: string;
  claimed_by: string;
}

/**
 * Whether the claim's run is still open in the log: its last run boundary (RUN_STARTED,
 * RUN_FINISHED or RUN_ERROR in any event carrying this claimId) is a RUN_STARTED. A claim
 * taken with `opensRun` starts one in its task.claimed event; a dispatcher claim's run is
 * the agent's own, logged as run.event, and may already be closed or never have started.
 */
async function runIsOpen(tx: Tx, taskId: string, claimId: string): Promise<boolean> {
  const [row] = await tx<{ type: string }[]>`
    select a.value->>'type' as type
    from events e cross join lateral jsonb_array_elements(e.agui) with ordinality as a(value, n)
    where e.thread_id = ${taskId} and e.data->>'claimId' = ${claimId}
      and a.value->>'type' in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')
    order by e.cursor desc, a.n desc
    limit 1`;
  return row?.type === "RUN_STARTED";
}

/**
 * Returns claimed tasks whose lease ended before `now` to `ready` and logs one
 * task.lease_expired event per task, all in one transaction: a RUN_ERROR when it closes
 * the claim's open run, else a teamkit.task.lease_expired CUSTOM. Rows locked by another
 * transaction are skipped and picked up by the next call. Returns the number of tasks
 * reaped.
 */
export async function reapExpired(db: Db, now: Date = new Date()): Promise<number> {
  return db.begin(async (tx) => {
    const rows = await tx<ReapedRow[]>`
      with x as (
        select t.thread_id, t.claim_id, t.claimed_by, th.room
        from tasks t join threads th on th.id = t.thread_id
        where t.state = 'claimed' and t.lease_expires_at < ${now}
        order by t.thread_id
        for update of t skip locked
      )
      update tasks t
      set state = 'ready', claim_id = null, claimed_by = null, lease_expires_at = null, updated_at = now()
      from x
      where t.thread_id = x.thread_id
      returning x.thread_id, x.room, x.claim_id, x.claimed_by`;
    rows.sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0));
    const open = new Map<string, boolean>();
    for (const r of rows) open.set(r.thread_id, await runIsOpen(tx, r.thread_id, r.claim_id));
    for (const r of rows) {
      await appendEvent(tx, {
        kind: "task.lease_expired",
        room: r.room,
        threadId: r.thread_id,
        actorId: r.claimed_by,
        agui: [
          open.get(r.thread_id)
            ? runError("lease expired", "teamkit.lease_expired")
            : custom("teamkit.task.lease_expired", { claimId: r.claim_id }),
        ],
        data: { taskId: r.thread_id, state: "ready", claimId: r.claim_id },
      });
    }
    return rows.length;
  });
}

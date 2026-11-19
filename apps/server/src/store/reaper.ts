import { runError } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { appendEvent } from "./events.js";

interface ReapedRow {
  thread_id: string;
  room: string;
  claim_id: string;
  claimed_by: string;
}

/**
 * Returns claimed tasks whose lease ended before `now` to `ready` and logs one
 * task.lease_expired event per task, all in one transaction. Rows locked by
 * another transaction are skipped and picked up by the next call. Returns the
 * number of tasks reaped.
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
    for (const r of rows) {
      await appendEvent(tx, {
        kind: "task.lease_expired",
        room: r.room,
        threadId: r.thread_id,
        actorId: r.claimed_by,
        agui: [runError("lease expired", "teamkit.lease_expired")],
        data: { taskId: r.thread_id, state: "ready", claimId: r.claim_id },
      });
    }
    return rows.length;
  });
}

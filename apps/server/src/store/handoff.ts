import { BoardError, custom, runError, type ActorRef, type Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { can, requirePerm, type AuthContext } from "./actors.js";
import { appendEvent } from "./events.js";
import { reserve } from "./reservations.js";
import { loadTask } from "./task-load.js";

/**
 * Hands a task to the named agent and holds it for them. The caller may hand off its own claim
 * (which ends the claim's run) or a ready task; a task already held for someone else may only
 * be handed on by its holder or by a person.
 */
export async function handoff(db: Db, auth: AuthContext, taskId: string, to: string): Promise<Task> {
  return db.begin(async (tx) => {
    const task = await loadTask(tx, taskId, { forUpdate: true });
    if (!task) throw new BoardError("not_found", `task ${taskId} not found`);
    await requirePerm(tx, auth, task.room, "claim");

    const [target] = await tx`select id, name, kind from actors where name = ${to}`;
    if (!target || target.kind !== "agent") throw new BoardError("invalid_input", `${to} is not an agent on this team`);
    if (target.id === auth.actor.id) throw new BoardError("invalid_input", "a task cannot be handed off to yourself");
    const toActor: ActorRef = { id: target.id as string, name: target.name as string, kind: "agent" };
    if (!(await can(tx, toActor, task.room, "claim"))) {
      throw new BoardError("invalid_input", `${to} cannot claim in ${task.room}`);
    }

    let claimId: string | null = null;
    if (task.state === "claimed") {
      if (task.claim?.actor.id !== auth.actor.id) throw new BoardError("task_claimed", `task ${taskId} is claimed by someone else`);
      claimId = task.claim.id;
      await tx`
        update tasks set state = 'ready', claim_id = null, claimed_by = null, lease_expires_at = null, updated_at = now()
        where thread_id = ${taskId}`;
    } else if (task.state === "ready") {
      const held = task.reservedFor && task.reservedUntil && Date.parse(task.reservedUntil) > Date.now();
      if (held && task.reservedFor!.id !== auth.actor.id && auth.actor.kind !== "person") {
        throw new BoardError("forbidden", `task ${taskId} is held for ${task.reservedFor!.name} until ${task.reservedUntil}`);
      }
    } else {
      throw new BoardError(
        "invalid_state",
        `task ${taskId} is ${task.state}; only a ready task or your own claim can be handed off`,
      );
    }

    const reservedUntil = await reserve(tx, taskId, toActor.id, "handoff");
    await appendEvent(tx, {
      kind: "task.handed_off",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.task.handed_off", { to: toActor, reservedUntil, claimId }),
        ...(claimId !== null ? [runError(`handed off to ${toActor.name}`, "teamkit.handed_off")] : []),
      ],
      data: { taskId, state: "ready", to: toActor, reservedUntil, claimId },
    });
    const out = await loadTask(tx, taskId);
    if (!out) throw new Error(`task ${taskId} vanished`);
    return out;
  });
}

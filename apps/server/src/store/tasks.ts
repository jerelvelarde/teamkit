import {
  BoardError,
  ID_PREFIXES,
  custom,
  isValidRoom,
  newId,
  textMessage,
  type PlanItem,
  type Task,
  type TaskState,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q, Tx } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { appendEvent, type AppendEventInput } from "./events.js";
import { appendMessage, assertText, ensureRoom, insertThread, messageFor, validateLabels } from "./rows.js";
import { loadTask } from "./task-load.js";

const MAX_PLAN_ITEMS = 200;
const MAX_TARGET_LENGTH = 200;
const PLAN_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function assertRoom(room: unknown): string {
  if (typeof room !== "string" || !isValidRoom(room)) {
    throw new BoardError("invalid_input", `invalid room name "${String(room)}"`);
  }
  return room;
}

function assertTarget(target: unknown): string | null {
  if (target === undefined || target === null) return null;
  if (typeof target !== "string") throw new BoardError("invalid_input", "target must be a string");
  if (target.length > MAX_TARGET_LENGTH) {
    throw new BoardError("invalid_input", `target exceeds ${MAX_TARGET_LENGTH} characters`);
  }
  return target;
}

function assertNeedIds(needs: unknown): string[] {
  if (needs === undefined) return [];
  if (!Array.isArray(needs) || needs.some((n) => typeof n !== "string" || n === "")) {
    throw new BoardError("invalid_input", "needs must be an array of task ids");
  }
  return [...new Set(needs as string[])];
}

/**
 * Locks the needed tasks with FOR SHARE (so none can be completed or deleted
 * under us, which would lose a promotion) and returns their states.
 */
async function lockNeeds(tx: Tx, ids: string[]): Promise<Map<string, TaskState>> {
  const states = new Map<string, TaskState>();
  if (ids.length === 0) return states;
  const rows = await tx<{ thread_id: string; state: TaskState }[]>`
    select thread_id, state from tasks where thread_id = any(${ids}) for share`;
  for (const r of rows) states.set(r.thread_id, r.state);
  for (const id of ids) {
    if (!states.has(id)) throw new BoardError("invalid_input", `unknown need ${id}`);
  }
  return states;
}

interface NewTask {
  room: string;
  brief: string;
  labels: Record<string, string>;
  needs: string[];
  target: string | null;
}

/** Row writes for one task; returns its id, state and the event to append afterwards. */
async function insertTaskRows(
  tx: Tx,
  auth: AuthContext,
  t: NewTask,
  needStates: Map<string, TaskState>,
): Promise<{ taskId: string; state: TaskState; event: AppendEventInput }> {
  const taskId = newId(ID_PREFIXES.thread);
  const state: TaskState = t.needs.every((id) => needStates.get(id) === "completed") ? "ready" : "waiting";
  await ensureRoom(tx, t.room);
  await insertThread(tx, { id: taskId, room: t.room, isTask: true, labels: t.labels, createdBy: auth.actor.id });
  await tx`insert into tasks (thread_id, state, brief, target) values (${taskId}, ${state}, ${t.brief}, ${t.target})`;
  for (const id of t.needs) await tx`insert into task_needs (task_id, needs_id) values (${taskId}, ${id})`;
  const messageId = newId(ID_PREFIXES.message);
  await appendMessage(tx, taskId, messageFor({ messageId, role: "user", text: t.brief, actor: auth.actor }));
  const needs = [...t.needs].sort();
  return {
    taskId,
    state,
    event: {
      kind: "task.created",
      room: t.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.task.created", {
          taskId,
          room: t.room,
          brief: t.brief,
          labels: t.labels,
          needs,
          target: t.target,
        }),
        ...textMessage({ messageId, role: "user", text: t.brief, actor: auth.actor }),
      ],
      data: { taskId, state, labels: t.labels, needs, target: t.target },
    },
  };
}

async function mustLoad(q: Q, taskId: string): Promise<Task> {
  const task = await loadTask(q, taskId);
  if (!task) throw new Error(`task ${taskId} vanished after insert`);
  return task;
}

export async function createTask(
  db: Db,
  auth: AuthContext,
  input: { room: string; brief: string; labels?: Record<string, string>; needs?: string[]; target?: string | null },
): Promise<Task> {
  const room = assertRoom(input.room);
  const brief = assertText("brief", input.brief, { required: true }) as string;
  const labels = validateLabels(input.labels);
  const target = assertTarget(input.target);
  const needs = assertNeedIds(input.needs);
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, room, "create");
    const needStates = await lockNeeds(tx, needs);
    const created = await insertTaskRows(tx, auth, { room, brief, labels, needs, target }, needStates);
    await appendEvent(tx, created.event);
    return mustLoad(tx, created.taskId);
  });
}

interface ValidItem {
  key: string;
  brief: string;
  labels: Record<string, string>;
  target: string | null;
  keyNeeds: string[];
  idNeeds: string[];
}

function validatePlan(plan: unknown): ValidItem[] {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new BoardError("invalid_input", "plan must be a non-empty array");
  }
  if (plan.length > MAX_PLAN_ITEMS) {
    throw new BoardError("invalid_input", `plan exceeds ${MAX_PLAN_ITEMS} items`);
  }
  const items: ValidItem[] = [];
  const seen = new Set<string>();
  for (const raw of plan as PlanItem[]) {
    const key = raw?.key;
    if (typeof key !== "string" || !PLAN_KEY.test(key)) {
      throw new BoardError("invalid_input", `invalid plan key "${String(key)}"`);
    }
    if (seen.has(key)) throw new BoardError("invalid_input", `duplicate plan key "${key}"`);
    seen.add(key);
    if (raw.needs !== undefined && !Array.isArray(raw.needs)) {
      throw new BoardError("invalid_input", `needs of "${key}" must be an array`);
    }
    const keyNeeds = new Set<string>();
    const idNeeds = new Set<string>();
    for (const n of raw.needs ?? []) {
      if (n && typeof n === "object" && "key" in n && typeof n.key === "string") keyNeeds.add(n.key);
      else if (n && typeof n === "object" && "id" in n && typeof n.id === "string" && n.id !== "") idNeeds.add(n.id);
      else throw new BoardError("invalid_input", `invalid need in "${key}"`);
    }
    items.push({
      key,
      brief: assertText(`text of "${key}"`, raw.text, { required: true }) as string,
      labels: validateLabels(raw.labels),
      target: assertTarget(raw.target),
      keyNeeds: [...keyNeeds],
      idNeeds: [...idNeeds],
    });
  }
  for (const it of items) {
    for (const k of it.keyNeeds) {
      if (!seen.has(k)) throw new BoardError("invalid_input", `unknown key "${k}" needed by "${it.key}"`);
    }
  }
  return items;
}

/**
 * Dependencies first. Walks items in plan order and emits each after its key needs, so
 * the result is deterministic and an already-ordered plan keeps its order.
 */
function topoOrder(items: ValidItem[]): ValidItem[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: ValidItem[] = [];
  const visit = (it: ValidItem): void => {
    if (done.has(it.key)) return;
    if (visiting.has(it.key)) throw new BoardError("invalid_input", `dependency cycle at "${it.key}"`);
    visiting.add(it.key);
    for (const k of it.keyNeeds) visit(byKey.get(k)!);
    visiting.delete(it.key);
    done.add(it.key);
    out.push(it);
  };
  for (const it of items) visit(it);
  return out;
}

export async function createPlan(
  db: Db,
  auth: AuthContext,
  room: string,
  plan: PlanItem[],
): Promise<Record<string, Task>> {
  const validRoom = assertRoom(room);
  const ordered = topoOrder(validatePlan(plan));
  return db.begin(async (tx) => {
    await requirePerm(tx, auth, validRoom, "create");
    const idNeeds = [...new Set(ordered.flatMap((i) => i.idNeeds))];
    const states = await lockNeeds(tx, idNeeds);
    const ids = new Map<string, string>();
    const events: AppendEventInput[] = [];
    for (const it of ordered) {
      const needs = [...new Set([...it.idNeeds, ...it.keyNeeds.map((k) => ids.get(k)!)])];
      const created = await insertTaskRows(
        tx,
        auth,
        { room: validRoom, brief: it.brief, labels: it.labels, needs, target: it.target },
        states,
      );
      ids.set(it.key, created.taskId);
      states.set(created.taskId, created.state);
      events.push(created.event);
    }
    for (const e of events) await appendEvent(tx, e);
    const out: Record<string, Task> = {};
    for (const it of plan) out[it.key] = await mustLoad(tx, ids.get(it.key)!);
    return out;
  });
}

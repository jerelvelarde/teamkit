import {
  BLOCK_KINDS,
  BoardError,
  ID_PREFIXES,
  choiceSchema,
  custom,
  newId,
  runFinishedInterrupt,
  textMessage,
  type BlockKind,
  type PendingResume,
  type Task,
  type TaskBlock,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { requirePerm, type AuthContext } from "./actors.js";
import { appendEvent } from "./events.js";
import { lockClaim } from "./claims.js";
import { getRoomInfo } from "./rooms.js";
import { appendMessage, assertCleanString, assertText, messageFor } from "./rows.js";
import { loadTask } from "./task-load.js";

const MAX_OPTIONS = 20;
const MAX_OPTION_LENGTH = 200;

async function mustLoad(q: Q, taskId: string): Promise<Task> {
  const task = await loadTask(q, taskId);
  if (!task) throw new Error(`task ${taskId} vanished`);
  return task;
}

function validateOptions(options: unknown): string[] | null {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS) {
    throw new BoardError("invalid_input", `options must be 1-${MAX_OPTIONS} strings`);
  }
  for (const o of options) {
    if (typeof o !== "string" || o.length === 0 || o.length > MAX_OPTION_LENGTH) {
      throw new BoardError("invalid_input", `each option must be a non-empty string of at most ${MAX_OPTION_LENGTH} characters`);
    }
    assertCleanString("option", o);
  }
  if (new Set(options).size !== options.length) throw new BoardError("invalid_input", "options must be unique");
  return options as string[];
}

/** The thread message a block leaves, so the question stays in the thread after it is answered. */
export function questionText(kind: BlockKind, question: string, options: string[] | null): string {
  return `Question (${kind}): ${question}${options ? ` [options: ${options.join("|")}]` : ""}`;
}

/**
 * claimed -> blocked. Posts the question to the thread as the blocking agent's message, ends the
 * run with an AG-UI interrupt and releases the claim.
 */
export async function block(
  db: Db,
  auth: AuthContext,
  taskId: string,
  claimId: string,
  input: { question: string; kind: BlockKind; options?: string[] },
): Promise<Task> {
  if (!(BLOCK_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new BoardError("invalid_input", `kind must be one of ${BLOCK_KINDS.join(", ")}`);
  }
  const question = assertText("question", input.question, { required: true }) as string;
  const options = validateOptions(input.options);
  return db.begin(async (tx) => {
    const task = await lockClaim(tx, auth, taskId, claimId);
    const interruptId = newId(ID_PREFIXES.interrupt);
    const stored: TaskBlock = { interruptId, kind: input.kind, question, options, blockedBy: auth.actor };
    await tx`
      update tasks
      set state = 'blocked', block = ${tx.json(stored as never)}, claim_id = null, claimed_by = null,
          lease_expires_at = null, updated_at = now()
      where thread_id = ${taskId}`;
    const messageId = newId(ID_PREFIXES.message);
    const said = questionText(input.kind, question, options);
    await appendMessage(tx, taskId, messageFor({ messageId, role: "assistant", text: said, actor: auth.actor }));
    await appendEvent(tx, {
      kind: "task.blocked",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [
        ...textMessage({ messageId, role: "assistant", text: said, actor: auth.actor }),
        runFinishedInterrupt(taskId, claimId, {
          id: interruptId,
          reason: input.kind,
          message: question,
          responseSchema: options ? choiceSchema(options) : undefined,
        }),
      ],
      data: { taskId, state: "blocked", interruptId, kind: input.kind, question, options, messageId },
    });
    return mustLoad(tx, taskId);
  });
}

/** blocked -> ready. An approval may only be answered by a person via a session. */
export async function answer(
  db: Db,
  auth: AuthContext,
  taskId: string,
  input: { text?: string; choice?: string },
): Promise<Task> {
  const text = assertText("text", input.text) || undefined;
  const choice = assertText("choice", input.choice) || undefined;
  if (text === undefined && choice === undefined) {
    throw new BoardError("invalid_input", "answer needs text or choice");
  }
  return db.begin(async (tx) => {
    const task = await loadTask(tx, taskId, { forUpdate: true });
    if (!task) throw new BoardError("not_found", `task ${taskId} not found`);
    if (task.state !== "blocked" || !task.block) {
      throw new BoardError("invalid_state", `task ${taskId} is ${task.state}, not blocked`);
    }
    const blk = task.block;
    if (blk.kind === "awaiting_approval") {
      const approvers = (await getRoomInfo(tx, task.room))?.approvers ?? null;
      const isPerson = auth.via === "session" && auth.actor.kind === "person";
      const isApprover = approvers === null || approvers.length === 0 || approvers.includes(auth.actor.name);
      if (!isPerson || !isApprover) {
        throw new BoardError(
          "approval_requires_person",
          `${auth.actor.name} cannot answer an approval on ${taskId}: it needs a listed person signed in`,
        );
      }
    } else {
      await requirePerm(tx, auth, task.room, "post");
    }
    // With options, the answer is the choice; text is only a comment on it.
    if (blk.options && choice === undefined) {
      throw new BoardError("invalid_input", `answer needs a choice, one of: ${blk.options.join(", ")}`);
    }
    if (choice !== undefined && !(blk.options ?? []).includes(choice)) {
      throw new BoardError("invalid_input", `choice "${choice}" is not one of the options`);
    }
    const payload: PendingResume["payload"] = {
      ...(text !== undefined ? { text } : {}),
      ...(choice !== undefined ? { choice } : {}),
    };
    const resume: PendingResume[] = [{ interruptId: blk.interruptId, status: "resolved", payload }];
    await tx`
      update tasks
      set state = 'ready', block = null, pending_resume = ${tx.json(resume as never)}, updated_at = now()
      where thread_id = ${taskId}`;
    const messageId = newId(ID_PREFIXES.message);
    const said = (text ?? choice) as string;
    await appendMessage(tx, taskId, messageFor({ messageId, role: "user", text: said, actor: auth.actor }));
    await appendEvent(tx, {
      kind: "task.answered",
      room: task.room,
      threadId: taskId,
      actorId: auth.actor.id,
      agui: [
        custom("teamkit.interrupt.answered", { interruptId: blk.interruptId, by: auth.actor, payload }),
        ...textMessage({ messageId, role: "user", text: said, actor: auth.actor }),
      ],
      data: { taskId, state: "ready", interruptId: blk.interruptId, kind: blk.kind, ...payload },
    });
    return mustLoad(tx, taskId);
  });
}

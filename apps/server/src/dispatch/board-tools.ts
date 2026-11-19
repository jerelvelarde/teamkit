import { BoardError, isBoardError, isBoardTool, type AguiMessage } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";
import { answer } from "../store/blocks.js";
import { createTask } from "../store/tasks.js";
import { getThread, reply, setLabel } from "../store/threads.js";

export interface BoardToolCall {
  id: string;
  name: string;
  args: string;
}

const READ_MESSAGES = 50;
const MAX_CONTENT = 4000;

type Args = Record<string, unknown>;

function parseArgs(raw: string): Args {
  if (raw.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new BoardError("invalid_input", "tool arguments are not valid JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new BoardError("invalid_input", "tool arguments must be a JSON object");
  }
  return v as Args;
}

function reqStr(a: Args, field: string): string {
  const v = a[field];
  if (typeof v !== "string") throw new BoardError("invalid_input", `${field} must be a string`);
  return v;
}

function optStr(a: Args, field: string): string | undefined {
  const v = a[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BoardError("invalid_input", `${field} must be a string`);
  return v;
}

function optStrArray(a: Args, field: string): string[] | undefined {
  const v = a[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new BoardError("invalid_input", `${field} must be an array of strings`);
  }
  return v as string[];
}

function optStrMap(a: Args, field: string): Record<string, string> | undefined {
  const v = a[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) {
    throw new BoardError("invalid_input", `${field} must be an object of string values`);
  }
  return v as Record<string, string>;
}

function clip(content: unknown): unknown {
  return typeof content === "string" && content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
}

async function run(db: Db, auth: AuthContext, name: string, a: Args): Promise<unknown> {
  if (!isBoardTool(name)) throw new BoardError("invalid_input", `unknown board tool ${name}`);
  switch (name) {
    case "teamkit_create_task": {
      const task = await createTask(db, auth, {
        room: reqStr(a, "room"),
        brief: reqStr(a, "brief"),
        labels: optStrMap(a, "labels"),
        needs: optStrArray(a, "needs"),
      });
      return { taskId: task.id, state: task.state };
    }
    case "teamkit_reply":
      await reply(db, auth, reqStr(a, "threadId"), reqStr(a, "text"));
      return { ok: true };
    case "teamkit_label":
      await setLabel(db, auth, reqStr(a, "threadId"), reqStr(a, "key"), reqStr(a, "value"));
      return { ok: true };
    case "teamkit_answer": {
      const task = await answer(db, auth, reqStr(a, "taskId"), {
        text: optStr(a, "text"),
        choice: optStr(a, "choice"),
      });
      return { taskId: task.id, state: task.state };
    }
    case "teamkit_read": {
      const view = await getThread(db, auth, reqStr(a, "threadId"));
      const t = view.task;
      return {
        thread: { id: view.thread.id, room: view.thread.room, labels: view.thread.labels },
        task: t && {
          id: t.id,
          state: t.state,
          brief: t.brief,
          block: t.block,
          result: t.result,
          needs: t.needs,
          needStates: t.needStates,
        },
        messages: view.messages.slice(-READ_MESSAGES).map((m: AguiMessage) => {
          const { role, name: who, content } = m as { role: string; name?: string; content?: unknown };
          return { role, name: who, content: clip(content) };
        }),
      };
    }
  }
}

/** Runs one board tool call with the agent's own permissions. Never throws. */
export async function executeBoardTool(
  db: Db,
  auth: AuthContext,
  call: BoardToolCall,
): Promise<{ ok: boolean; content: string }> {
  try {
    const value = await run(db, auth, call.name, parseArgs(call.args));
    return { ok: true, content: JSON.stringify(value) };
  } catch (e) {
    if (isBoardError(e)) {
      return { ok: false, content: JSON.stringify({ error: { code: e.code, message: e.message } }) };
    }
    console.error(`board tool ${call.name} failed`, e);
    return { ok: false, content: JSON.stringify({ error: { code: "internal", message: "board tool failed" } }) };
  }
}

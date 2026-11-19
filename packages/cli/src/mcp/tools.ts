import * as z from "zod";
import { firstLine, formatPending, formatRoom, formatThread } from "../format.js";
import type { Leases } from "./leases.js";
import type { Session } from "./session.js";

/** Every TeamKit MCP tool, in the order the index fixes. */
export const MCP_TOOL_NAMES = [
  "teamkit_pending",
  "teamkit_read",
  "teamkit_create_task",
  "teamkit_claim",
  "teamkit_reply",
  "teamkit_handoff",
  "teamkit_ask",
  "teamkit_complete",
  "teamkit_fail",
  "teamkit_release",
  "teamkit_decide",
  "teamkit_ack",
  "teamkit_rollcall_start",
  "teamkit_rollcall_answer",
  "teamkit_log_change",
  "teamkit_update_change",
  "teamkit_alert",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface ToolDeps {
  session: Session;
  leases: Leases;
}

export interface McpTool {
  name: McpToolName;
  description: string;
  inputSchema: z.ZodObject;
  /** `input` has already passed `inputSchema`. */
  run(deps: ToolDeps, input: any): Promise<string>;
}

function exactlyOne(a: unknown, b: unknown, names: string): void {
  if ((a === undefined) === (b === undefined)) throw new Error(`give exactly one of ${names}`);
}

/** The ten task tools: read the board, and claim, work and settle tasks without passing claim ids. */
export const taskTools: McpTool[] = [
  {
    name: "teamkit_pending",
    description:
      "What is waiting on you: tasks handed off to you, your asks that were answered, decisions to acknowledge and roll calls to answer. Call it first in every turn.",
    inputSchema: z.object({}),
    async run({ session }) {
      const p = await session.client().pending();
      const empty = [p.handoffs, p.answered, p.decisions, p.rollCalls, p.asks].every((l) => l.length === 0);
      return empty ? "Nothing is waiting on you." : formatPending(p, { brief: false });
    },
  },
  {
    name: "teamkit_read",
    description: "Read a task thread (threadId) or the threads in a room (room). Give exactly one.",
    inputSchema: z.object({ threadId: z.string().optional(), room: z.string().optional() }),
    async run({ session }, input: { threadId?: string; room?: string }) {
      exactlyOne(input.threadId, input.room, "threadId and room");
      const client = session.client();
      return input.threadId !== undefined
        ? formatThread(await client.thread(input.threadId))
        : formatRoom(await client.room(input.room!));
    },
  },
  {
    name: "teamkit_create_task",
    description:
      "Create a task in a room. To ask something that belongs to no task, create a task for it first. target starts a registered agent the server runs; to give a task to a person's agent (such as ben-agent), claim it and hand it off.",
    inputSchema: z.object({
      room: z.string(),
      brief: z.string(),
      labels: z.record(z.string(), z.string()).optional(),
      needs: z.array(z.string()).optional(),
      target: z.string().optional(),
    }),
    async run({ session }, input: { room: string; brief: string; labels?: Record<string, string>; needs?: string[]; target?: string }) {
      const t = await session.client().createTask(input);
      return `${t.id}\t${t.state}`;
    },
  },
  {
    name: "teamkit_claim",
    description:
      "Claim a task by id, or the next ready task in a room. Claim a task before you act on it. TeamKit keeps your claim alive while this session runs.",
    inputSchema: z.object({ taskId: z.string().optional(), room: z.string().optional() }),
    async run({ session, leases }, input: { taskId?: string; room?: string }) {
      exactlyOne(input.taskId, input.room, "taskId and room");
      const client = session.client();
      const c = input.taskId !== undefined ? await client.claim(input.taskId) : await client.claimNext(input.room!, { waitMs: 0 });
      if (!c) return `Nothing ready in ${input.room}.`;
      leases.hold(c.task.id, c.claimId);
      return `Claimed ${c.task.id} in ${c.task.room}: ${firstLine(c.task.brief)}`;
    },
  },
  {
    name: "teamkit_reply",
    description: "Post a short reply on a task thread: your plan, a step you finished, a recommendation.",
    inputSchema: z.object({ threadId: z.string(), text: z.string() }),
    async run({ session }, input: { threadId: string; text: string }) {
      await session.client().reply(input.threadId, input.text);
      return "ok";
    },
  },
  {
    name: "teamkit_handoff",
    description:
      "Hand a task you hold to a named agent. It is held for that agent for a while, then returns to the open queue. Reply first with what is done and what is left.",
    inputSchema: z.object({ taskId: z.string(), to: z.string() }),
    async run({ session, leases }, input: { taskId: string; to: string }) {
      const t = await session.client().handoff(input.taskId, input.to);
      leases.drop(input.taskId);
      return `${t.id} held for ${input.to} until ${t.reservedUntil}`;
    },
  },
  {
    name: "teamkit_ask",
    description:
      "Block a task you hold on a question. Name the person who must answer in approvers, and use kind awaiting_approval for anything that needs permission. Only that person, or an admin, can answer. Stop working on the task after you ask.",
    inputSchema: z.object({
      taskId: z.string(),
      question: z.string(),
      kind: z.enum(["needs_input", "awaiting_approval"]).optional(),
      options: z.array(z.string()).optional(),
      approvers: z.array(z.string()).optional(),
    }),
    async run(
      { session, leases },
      input: { taskId: string; question: string; kind?: "needs_input" | "awaiting_approval"; options?: string[]; approvers?: string[] },
    ) {
      const { taskId, ...ask } = input;
      const t = await session.client().block(taskId, leases.claimFor(taskId), ask);
      leases.drop(taskId);
      const named = t.block?.approvers ?? input.approvers;
      return `${t.id}\t${t.state}${named && named.length > 0 ? ` waiting on ${named.join(", ")}` : ""}`;
    },
  },
  {
    name: "teamkit_complete",
    description: "Complete a task you hold, with a result that says what you did.",
    inputSchema: z.object({ taskId: z.string(), result: z.string().min(1) }),
    async run({ session, leases }, input: { taskId: string; result: string }) {
      const t = await session.client().complete(input.taskId, leases.claimFor(input.taskId), input.result);
      leases.drop(input.taskId);
      return `${t.id}\t${t.state}`;
    },
  },
  {
    name: "teamkit_fail",
    description: "Fail a task you hold, with the reason.",
    inputSchema: z.object({ taskId: z.string(), reason: z.string().min(1) }),
    async run({ session, leases }, input: { taskId: string; reason: string }) {
      const t = await session.client().fail(input.taskId, leases.claimFor(input.taskId), input.reason);
      leases.drop(input.taskId);
      return `${t.id}\t${t.state}`;
    },
  },
  {
    name: "teamkit_release",
    description:
      "Give back a task you hold but will not finish, so another agent can claim it. Reply first with what is done and what is left.",
    inputSchema: z.object({ taskId: z.string() }),
    async run({ session, leases }, input: { taskId: string }) {
      const t = await session.client().release(input.taskId, leases.claimFor(input.taskId));
      leases.drop(input.taskId);
      return `${t.id}\t${t.state}`;
    },
  },
];

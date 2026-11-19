import * as z from "zod";
import { CHANGE_STATUSES, type ChangeStatus } from "@copilotkit/teamkit-protocol";
import type { McpTool } from "./tools.js";

/**
 * Decisions, roll calls, the change log and alerts. Agents record, acknowledge and raise; none of
 * these tools answers an ask, or confirms or resolves an alert: people decide.
 */
export const coordinationTools: McpTool[] = [
  {
    name: "teamkit_decide",
    description:
      "Record a decision your person made. decidedBy is your owner's name; you cannot record anyone else's decision. A decision is a record, not a permission.",
    inputSchema: z.object({ room: z.string(), text: z.string(), decidedBy: z.string() }),
    async run({ session }, input: { room: string; text: string; decidedBy: string }) {
      const d = await session.client().postDecision(input);
      return `Decision ${d.id} recorded for ${d.decidedBy.name}`;
    },
  },
  {
    name: "teamkit_ack",
    description: "Acknowledge a decision after you have read it. It records that you read it; it grants nothing.",
    inputSchema: z.object({ decisionId: z.string() }),
    async run({ session }, input: { decisionId: string }) {
      const d = await session.client().ackDecision(input.decisionId);
      return `Acknowledged ${d.id}`;
    },
  },
  {
    name: "teamkit_rollcall_start",
    description:
      "Start a roll call in a room: every agent there answers with its status. Use it when you lead the work and need to know who is on; never ask in a reply.",
    inputSchema: z.object({ room: z.string() }),
    async run({ session }, input: { room: string }) {
      const r = await session.client().startRollCall(input.room);
      return `Roll call ${r.id} started in ${r.room}`;
    },
  },
  {
    name: "teamkit_rollcall_answer",
    description: "Answer a roll call with your status in a few words.",
    inputSchema: z.object({ rollCallId: z.string(), status: z.string().min(1) }),
    async run({ session }, input: { rollCallId: string; status: string }) {
      const r = await session.client().answerRollCall(input.rollCallId, input.status);
      return `Answered roll call ${r.id}`;
    },
  },
  {
    name: "teamkit_log_change",
    description:
      "Log a change to something shared: what, where, how to undo it and when it should be undone. Names and short identifiers only, never secret values. TeamKit records undoWhen; it reminds nobody.",
    inputSchema: z.object({
      room: z.string(),
      what: z.string(),
      where: z.string(),
      undo: z.string(),
      at: z.string().optional(),
      undoWhen: z.string().optional(),
      taskId: z.string().optional(),
    }),
    async run(
      { session },
      input: { room: string; what: string; where: string; undo: string; at?: string; undoWhen?: string; taskId?: string },
    ) {
      const { taskId, ...change } = input;
      const c = await session.client().logChange({ ...change, ...(taskId === undefined ? {} : { threadId: taskId }) });
      return `Logged change ${c.id} (${c.status})`;
    },
  },
  {
    name: "teamkit_update_change",
    description: "Mark a logged change done, restored, or active again.",
    inputSchema: z.object({ changeId: z.string(), status: z.enum(CHANGE_STATUSES) }),
    async run({ session }, input: { changeId: string; status: ChangeStatus }) {
      const c = await session.client().updateChange(input.changeId, input.status);
      return `Change ${c.id} is ${c.status}`;
    },
  },
  {
    name: "teamkit_alert",
    description:
      "Raise a suspected alert about something you noticed, with what you saw. Only a person can confirm or resolve it.",
    inputSchema: z.object({ room: z.string(), text: z.string() }),
    async run({ session }, input: { room: string; text: string }) {
      const a = await session.client().raiseAlert(input);
      return `Alert ${a.id} raised as ${a.level}`;
    },
  },
];

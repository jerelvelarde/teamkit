import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { Context } from "hono";
import { ev, readInput, sseResponse } from "./sse.js";

const CHOICE_SCHEMA = {
  type: "object",
  properties: { choice: { type: "string", enum: ["approve", "reject"] } },
  required: ["choice"],
};

function firstUserLine(input: RunAgentInput): string {
  const m = input.messages.find((x) => x.role === "user");
  const content = m && typeof m.content === "string" ? m.content : "";
  return content.split("\n")[0]?.trim() ?? "";
}

/** Scripted approver: states a plan and asks for approval, then reports the outcome on resume. */
export function approverEvents(input: RunAgentInput): BaseEvent[] {
  const ids = { threadId: input.threadId, runId: input.runId };
  const resume = input.resume?.[0];
  if (resume) {
    const payload = (resume.payload ?? {}) as { choice?: unknown; text?: unknown };
    const choice = String(payload.choice ?? payload.text ?? "");
    const approved = choice.trim().toLowerCase() === "approve";
    return [
      ev.runStarted(ids),
      ...ev.text(`msg_${input.runId}`, approved ? "Shipped." : "Stopped."),
      ev.success(ids, approved ? "shipped" : "stopped"),
    ];
  }
  return [
    ev.runStarted(ids),
    ...ev.text(
      `msg_${input.runId}`,
      `Plan: ship "${firstUserLine(input)}". I need approval first.`,
    ),
    ev.interrupt(ids, {
      id: `approve_${input.runId}`,
      reason: "awaiting_approval",
      message: "Approve shipping?",
      responseSchema: CHOICE_SCHEMA,
    }),
  ];
}

export async function approverHandler(c: Context): Promise<Response> {
  let input: RunAgentInput;
  try {
    input = await readInput(c);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  return sseResponse(approverEvents(input));
}

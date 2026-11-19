import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import type { Context } from "hono";
import { ev, readInput, sseResponse } from "./sse.js";

const WAKE = /Task (th_[0-9a-f]{16}) in (\S+) is now (\w+)/;

interface ToolPayload {
  task?: { block?: { kind?: string; options?: string[] | null } | null } | null;
  error?: { code?: string };
}

function textOf(m: Message): string {
  return "content" in m && typeof m.content === "string" ? m.content : "";
}

function parsePayload(content: string): ToolPayload {
  try {
    const v: unknown = JSON.parse(content);
    return v !== null && typeof v === "object" ? (v as ToolPayload) : {};
  } catch {
    return {};
  }
}

/** Name of the tool call that produced a tool message, found on an earlier assistant message. */
function toolNameFor(messages: Message[], toolCallId: string): string | undefined {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const call = m.toolCalls?.find((c) => c.id === toolCallId);
    if (call) return call.function.name;
  }
  return undefined;
}

/**
 * Scripted lead: wakes on "Task <id> in <room> is now <state>", reads a blocked task, and answers
 * a needs_input question with the first option or "Go with your recommendation.".
 */
export function leadEvents(input: RunAgentInput): BaseEvent[] {
  const ids = { threadId: input.threadId, runId: input.runId };
  const say = (text: string): BaseEvent[] => [
    ev.runStarted(ids),
    ...ev.text(`msg_${input.runId}`, text),
    ev.success(ids),
  ];

  let wakeAt = -1;
  let wake: RegExpMatchArray | null = null;
  input.messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const hit = textOf(m).match(WAKE);
    if (hit) {
      wakeAt = i;
      wake = hit;
    }
  });
  if (!wake) return say("Nothing to do.");
  const [, id, , state] = wake as RegExpMatchArray;
  if (state !== "blocked") return say(`Noted: ${id} is ${state}.`);

  const tools = input.messages.slice(wakeAt + 1).filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  const call = (name: string, suffix: string, args: unknown): BaseEvent[] => [
    ev.runStarted(ids),
    ...ev.toolCall(`${input.runId}-${suffix}`, name, args),
    ev.success(ids),
  ];
  if (!last) return call("teamkit_read", "read", { threadId: id });

  const content = textOf(last);
  const payload = parsePayload(content);
  const name =
    last.role === "tool" ? toolNameFor(input.messages, last.toolCallId) : undefined;
  const isAnswer = name ? name === "teamkit_answer" : !("thread" in payload) && !payload.error;
  if (isAnswer) {
    return payload.error
      ? say(`Could not answer ${id}: ${payload.error.code ?? "error"}`)
      : say(`Answered ${id}.`);
  }
  if (payload.error) return say(`Could not read ${id}: ${payload.error.code ?? "error"}`);

  const block = payload.task?.block;
  if (!block) return say("Already answered.");
  if (block.kind === "awaiting_approval") {
    return say(`Approvals need a person; leaving ${id} for an approver.`);
  }
  if (block.kind === "needs_input") {
    const first = block.options?.[0];
    return call(
      "teamkit_answer",
      "answer",
      first !== undefined ? { taskId: id, choice: first } : { taskId: id, text: "Go with your recommendation." },
    );
  }
  return say("Already answered.");
}

export async function leadHandler(c: Context): Promise<Response> {
  let input: RunAgentInput;
  try {
    input = await readInput(c);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  return sseResponse(leadEvents(input));
}

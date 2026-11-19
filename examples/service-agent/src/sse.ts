import { EventType } from "@ag-ui/core";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { Context } from "hono";

export async function readInput(c: Context): Promise<RunAgentInput> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const b = body as Partial<RunAgentInput> | undefined;
  if (
    !b ||
    typeof b !== "object" ||
    typeof b.threadId !== "string" ||
    typeof b.runId !== "string" ||
    !Array.isArray(b.messages)
  ) {
    throw Response.json({ error: "bad RunAgentInput" }, { status: 400 });
  }
  return b as RunAgentInput;
}

type Emit = (e: BaseEvent) => void;

export function sseResponse(
  events: BaseEvent[] | ((emit: Emit) => Promise<void>),
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (e) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        if (typeof events === "function") await events(emit);
        else events.forEach(emit);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export const ev = {
  runStarted: (i: { threadId: string; runId: string }): BaseEvent =>
    ({ type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId }) as BaseEvent,

  text: (messageId: string, text: string): BaseEvent[] =>
    [
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ] as BaseEvent[],

  success: (
    i: { threadId: string; runId: string },
    result?: unknown,
  ): BaseEvent =>
    ({
      type: EventType.RUN_FINISHED,
      threadId: i.threadId,
      runId: i.runId,
      outcome: { type: "success" },
      ...(result === undefined ? {} : { result }),
    }) as BaseEvent,

  interrupt: (
    i: { threadId: string; runId: string },
    p: { id: string; reason: string; message: string; responseSchema?: unknown },
  ): BaseEvent =>
    ({
      type: EventType.RUN_FINISHED,
      threadId: i.threadId,
      runId: i.runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: p.id,
            reason: p.reason,
            message: p.message,
            ...(p.responseSchema === undefined ? {} : { responseSchema: p.responseSchema }),
          },
        ],
      },
    }) as BaseEvent,

  runError: (message: string, code: string): BaseEvent =>
    ({ type: EventType.RUN_ERROR, message, code }) as BaseEvent,

  toolCall: (id: string, name: string, args: unknown): BaseEvent[] =>
    [
      { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) },
      { type: EventType.TOOL_CALL_END, toolCallId: id },
    ] as BaseEvent[],
};

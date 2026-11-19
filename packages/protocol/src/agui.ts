import { EventType } from "@ag-ui/core";
import type { ActorRef, AguiEvent, BlockKind } from "./types.js";

function actorMetadata(actor: ActorRef) {
  return { teamkit: { actorId: actor.id, actorName: actor.name, actorKind: actor.kind } };
}

export function textMessage(args: {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  actor: ActorRef;
}): AguiEvent[] {
  const { messageId, role, text, actor } = args;
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role, metadata: actorMetadata(actor) },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text, metadata: actorMetadata(actor) },
    { type: EventType.TEXT_MESSAGE_END, messageId, metadata: actorMetadata(actor) },
  ];
}

export function custom(name: string, value: unknown): AguiEvent {
  return { type: EventType.CUSTOM, name, value };
}

export function runStarted(threadId: string, runId: string, claimId: string): AguiEvent {
  return { type: EventType.RUN_STARTED, threadId, runId, metadata: { teamkit: { claimId } } };
}

export function runFinishedSuccess(threadId: string, runId: string, result: string | null): AguiEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: { type: "success" },
    ...(result !== null ? { result } : {}),
  };
}

export function runFinishedInterrupt(
  threadId: string,
  runId: string,
  interrupt: { id: string; reason: BlockKind; message: string; responseSchema?: object },
): AguiEvent {
  const { id, reason, message, responseSchema } = interrupt;
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: {
      type: "interrupt",
      interrupts: [{ id, reason, message, ...(responseSchema !== undefined ? { responseSchema } : {}) }],
    },
  };
}

export function runError(message: string, code: string): AguiEvent {
  return { type: EventType.RUN_ERROR, message, code };
}

export function choiceSchema(options: string[]): object {
  return {
    type: "object",
    properties: { choice: { type: "string", enum: options } },
    required: ["choice"],
  };
}

import { renderToIR } from "@copilotkit/channels";
import { renderSlackMessage, slackFallbackText } from "@copilotkit/channels/slack/render";
import { ANSWER_ACTION_ID, type AnswerValue } from "./cards.js";

type Renderable = Parameters<typeof renderToIR>[0];

/** Render a card to Slack Block Kit plus the plain-text fallback `chat.postMessage` needs. */
export function toSlackMessage(ui: Renderable): { blocks: any[]; text: string } {
  const ir = renderToIR(ui);
  const blocks: any[] = renderSlackMessage(ir).blocks;
  for (const block of blocks) {
    if (block?.type !== "actions" || !Array.isArray(block.elements)) continue;
    for (const el of block.elements) {
      if (el?.type === "button" && el.value !== undefined && el.url === undefined) {
        el.action_id = ANSWER_ACTION_ID;
      }
    }
  }
  return { blocks, text: slackFallbackText(ir) };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseAnswerValue(v: unknown): AnswerValue | null {
  let value = v;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { taskId, interruptId, choice } = value as Record<string, unknown>;
  if (!nonEmpty(taskId) || !nonEmpty(interruptId) || !nonEmpty(choice)) return null;
  return { taskId, interruptId, choice };
}

import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { Context } from "hono";
import { ev, readInput, sseResponse } from "./sse.js";

const SYSTEM_PROMPT =
  "You are a research agent working one TeamKit task. Post progress with teamkit_reply on the task thread and tag findings with teamkit_label. Finish with a short summary.";

/** After this many tool results the model must wrap up instead of calling more tools. */
const MAX_TOOL_MESSAGES = 8;

interface ChatCompletion {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : "";
}

function toChatMessages(input: RunAgentInput): unknown[] {
  const out: unknown[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of input.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: contentText(m.content) });
    } else if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: contentText(m.content),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.function.name, arguments: t.function.arguments },
              })),
            }
          : {}),
      });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: contentText(m.content) });
    }
  }
  return out;
}

/** Builds the Chat Completions request body for one run. */
export function researcherRequest(input: RunAgentInput, env: NodeJS.ProcessEnv): unknown {
  const toolMessages = input.messages.filter((m) => m.role === "tool").length;
  return {
    model: env.TEAMKIT_MODEL || "gpt-5.6-sol",
    // gpt-5.6 models on Chat Completions only call tools with reasoning off.
    reasoning_effort: "none",
    messages: toChatMessages(input),
    tools: input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: toolMessages >= MAX_TOOL_MESSAGES ? "none" : "auto",
  };
}

/** Translates one Chat Completions response into AG-UI events. */
export function researcherEvents(input: RunAgentInput, completion: ChatCompletion): BaseEvent[] {
  const ids = { threadId: input.threadId, runId: input.runId };
  const message = completion.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  if (toolCalls.length > 0) {
    return [
      ev.runStarted(ids),
      ...toolCalls.flatMap((t) => {
        let args: unknown = {};
        try {
          args = JSON.parse(t.function.arguments);
        } catch {
          // fall through: the board rejects bad arguments with its own error
        }
        return ev.toolCall(t.id, t.function.name, args);
      }),
      ev.success(ids),
    ];
  }
  const text = message?.content ?? "";
  return [ev.runStarted(ids), ...ev.text(`msg_${input.runId}`, text), ev.success(ids, text)];
}

function failure(input: RunAgentInput, message: string): BaseEvent[] {
  return [
    ev.runStarted({ threadId: input.threadId, runId: input.runId }),
    ev.runError(message, "openai_error"),
  ];
}

export function researcherHandler(env: NodeJS.ProcessEnv): (c: Context) => Promise<Response> {
  return async (c) => {
    let input: RunAgentInput;
    try {
      input = await readInput(c);
    } catch (res) {
      if (res instanceof Response) return res;
      throw res;
    }
    const url = `${env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(researcherRequest(input, env)),
      });
      if (!res.ok) return sseResponse(failure(input, `OpenAI returned HTTP ${res.status}`));
      return sseResponse(researcherEvents(input, (await res.json()) as ChatCompletion));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "request failed";
      return sseResponse(failure(input, `OpenAI request failed: ${reason}`));
    }
  };
}

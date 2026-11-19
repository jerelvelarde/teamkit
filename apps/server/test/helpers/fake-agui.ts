import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunAgentInput } from "@ag-ui/core";

export type FakeStep = { event: Record<string, unknown> } | { drop: true } | { delayMs: number };
export type FakeScript = (input: RunAgentInput, call: number) => FakeStep[];

async function readJson(req: IncomingMessage): Promise<RunAgentInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunAgentInput;
}

/** A scripted AG-UI agent over real sockets. Each POST plays one script run as SSE frames. */
export async function startFakeAgui(
  script: FakeScript,
): Promise<{ url: string; inputs: RunAgentInput[]; calls(): number; stop(): Promise<void> }> {
  const inputs: RunAgentInput[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    void (async () => {
      const input = await readJson(req);
      const call = inputs.length;
      inputs.push(input);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const step of script(input, call)) {
        if ("drop" in step) {
          res.destroy();
          return;
        }
        if ("delayMs" in step) {
          await new Promise((r) => setTimeout(r, step.delayMs));
          continue;
        }
        res.write(`data: ${JSON.stringify(step.event)}\n\n`);
      }
      res.end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    inputs,
    calls: () => inputs.length,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const steps = {
  started(i: RunAgentInput): FakeStep {
    return { event: { type: "RUN_STARTED", threadId: i.threadId, runId: i.runId } };
  },
  text(messageId: string, text: string): FakeStep[] {
    return [
      { event: { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } },
      { event: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text } },
      { event: { type: "TEXT_MESSAGE_END", messageId } },
    ];
  },
  toolCall(toolCallId: string, name: string, args: unknown): FakeStep[] {
    return [
      { event: { type: "TOOL_CALL_START", toolCallId, toolCallName: name } },
      { event: { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args) } },
      { event: { type: "TOOL_CALL_END", toolCallId } },
    ];
  },
  success(i: RunAgentInput, result?: string): FakeStep {
    const event: Record<string, unknown> = {
      type: "RUN_FINISHED",
      threadId: i.threadId,
      runId: i.runId,
      outcome: { type: "success" },
    };
    if (result !== undefined) event.result = result;
    return { event };
  },
  interrupt(
    i: RunAgentInput,
    it: { id: string; reason: string; message: string; options?: string[] },
  ): FakeStep {
    const interrupt: Record<string, unknown> = { id: it.id, reason: it.reason, message: it.message };
    if (it.options) {
      interrupt.responseSchema = {
        type: "object",
        properties: { choice: { type: "string", enum: it.options } },
        required: ["choice"],
      };
    }
    return {
      event: {
        type: "RUN_FINISHED",
        threadId: i.threadId,
        runId: i.runId,
        outcome: { type: "interrupt", interrupts: [interrupt] },
      },
    };
  },
  runError(message: string, code?: string): FakeStep {
    const event: Record<string, unknown> = { type: "RUN_ERROR", message };
    if (code !== undefined) event.code = code;
    return { event };
  },
};

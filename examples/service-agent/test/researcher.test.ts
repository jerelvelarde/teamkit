import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunAgentInput } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { createExampleApp } from "../src/app.js";

const input: RunAgentInput = {
  threadId: "th_1",
  runId: "run_1",
  messages: [
    { id: "m1", role: "user", content: "Find three sources" },
    {
      id: "m2",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "teamkit_reply", arguments: "{}" } }],
    },
    { id: "m3", role: "tool", toolCallId: "c1", content: "ok" },
  ],
  tools: [
    { name: "teamkit_reply", description: "Reply", parameters: { type: "object" } },
    { name: "teamkit_label", description: "Label", parameters: { type: "object" } },
  ],
  context: [{ description: "TeamKit task", value: '{"taskId":"th_1","room":"research"}' }],
  state: {},
  forwardedProps: {},
};

async function withFakeOpenAI<T>(
  respond: () => { status: number; body: unknown },
  fn: (env: NodeJS.ProcessEnv, bodies: any[]) => Promise<T>,
): Promise<T> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer test");
      bodies.push(JSON.parse(raw));
      const r = respond();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(
      { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
      bodies,
    );
  } finally {
    server.close();
  }
}

async function run(env: NodeJS.ProcessEnv, body: RunAgentInput = input): Promise<any[]> {
  const res = await createExampleApp(env).request("/researcher", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  for (const e of events) EventSchemas.parse(e);
  return events;
}

test("request carries model, reasoning_effort none and the board tools", async () => {
  await withFakeOpenAI(
    () => ({ status: 200, body: { choices: [{ message: { content: "hi" } }] } }),
    async (env, bodies) => {
      await run(env);
      const b = bodies[0];
      assert.equal(b.model, "gpt-5.6-sol");
      assert.equal(b.reasoning_effort, "none");
      assert.equal(b.tool_choice, "auto");
      assert.deepEqual(
        b.tools.map((t: any) => t.function.name),
        ["teamkit_reply", "teamkit_label"],
      );
      assert.equal(b.messages[0].role, "system");
      assert.equal(b.messages[3].tool_calls[0].function.name, "teamkit_reply");
      assert.deepEqual(b.messages[4], { role: "tool", tool_call_id: "c1", content: "ok" });
    },
  );
});

test("a second system message carries the thread id and the task context", async () => {
  await withFakeOpenAI(
    () => ({ status: 200, body: { choices: [{ message: { content: "hi" } }] } }),
    async (env, bodies) => {
      await run(env);
      const [, context, user] = bodies[0].messages;
      assert.equal(context.role, "system");
      assert.equal(
        context.content,
        'TeamKit thread: th_1. Use it as threadId for teamkit_reply and teamkit_label.\nTeamKit task: {"taskId":"th_1","room":"research"}',
      );
      assert.deepEqual(user, { role: "user", content: "Find three sources" });
    },
  );
});

test("a model call slower than OPENAI_TIMEOUT_MS ends the run with openai_error", async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const t0 = Date.now();
    const events = await run({
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_TIMEOUT_MS: "200",
    });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    assert.deepEqual(events.map((e) => e.type), ["RUN_STARTED", "RUN_ERROR"]);
    assert.equal(events[1].code, "openai_error");
    assert.match(events[1].message, /^OpenAI request failed: .*timeout/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("TEAMKIT_MODEL overrides the model and 8 tool messages turn tools off", async () => {
  await withFakeOpenAI(
    () => ({ status: 200, body: { choices: [{ message: { content: "done" } }] } }),
    async (env, bodies) => {
      const many: RunAgentInput = {
        ...input,
        messages: Array.from({ length: 8 }, (_, i) => ({
          id: `t${i}`,
          role: "tool" as const,
          toolCallId: `c${i}`,
          content: "ok",
        })),
      };
      await run({ ...env, TEAMKIT_MODEL: "other-model" }, many);
      assert.equal(bodies[0].model, "other-model");
      assert.equal(bodies[0].tool_choice, "none");
    },
  );
});

test("tool_calls response becomes tool call events and a success without result", async () => {
  await withFakeOpenAI(
    () => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "teamkit_reply", arguments: '{"text":"hi"}' } },
              ],
            },
          },
        ],
      },
    }),
    async (env) => {
      const events = await run(env);
      const start = events.find((e) => e.type === "TOOL_CALL_START");
      assert.equal(start.toolCallName, "teamkit_reply");
      assert.equal(start.toolCallId, "call_1");
      assert.equal(events.find((e) => e.type === "TOOL_CALL_ARGS").delta, '{"text":"hi"}');
      const fin = events.at(-1);
      assert.equal(fin.type, "RUN_FINISHED");
      assert.deepEqual(fin.outcome, { type: "success" });
      assert.equal("result" in fin, false);
    },
  );
});

test("content response becomes text and a success with the result", async () => {
  await withFakeOpenAI(
    () => ({ status: 200, body: { choices: [{ message: { content: "All done." } }] } }),
    async (env) => {
      const events = await run(env);
      assert.equal(events.find((e) => e.type === "TEXT_MESSAGE_CONTENT").delta, "All done.");
      const fin = events.at(-1);
      assert.deepEqual(fin.outcome, { type: "success" });
      assert.equal(fin.result, "All done.");
    },
  );
});

test("an HTTP 500 becomes RUN_ERROR openai_error", async () => {
  await withFakeOpenAI(
    () => ({ status: 500, body: { error: "boom" } }),
    async (env) => {
      const events = await run(env);
      assert.deepEqual(events.map((e) => e.type), ["RUN_STARTED", "RUN_ERROR"]);
      assert.equal(events[1].code, "openai_error");
    },
  );
});

test("an unreachable API becomes RUN_ERROR openai_error", async () => {
  const events = await run({ OPENAI_API_KEY: "test", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" });
  assert.equal(events.at(-1).code, "openai_error");
});

test("without OPENAI_API_KEY the researcher is not mounted", async () => {
  const app = createExampleApp({});
  const res = await app.request("/researcher", { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});

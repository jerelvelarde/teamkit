import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createExampleApp } from "../src/app.js";
import { leadEvents } from "../src/lead.js";

const ID = "th_0123456789abcdef";
const wakeMsg = (state: string): Message => ({
  id: "w1",
  role: "user",
  content: `Task ${ID} in build is now ${state}: pick a db. Read it with teamkit_read.`,
});

const input = (messages: Message[], runId = "run_1"): RunAgentInput => ({
  threadId: "th_lead",
  runId,
  messages,
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

const asked = (name: string, id: string): Message => ({
  id: `a_${id}`,
  role: "assistant",
  toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
const result = (id: string, body: unknown): Message => ({
  id: `t_${id}`,
  role: "tool",
  toolCallId: id,
  content: JSON.stringify(body),
});
const readResult = (block: unknown) => result("c1", { thread: { id: ID }, task: { id: ID, state: "blocked", block } });

function run(messages: Message[]) {
  const events = leadEvents(input(messages));
  for (const e of events) EventSchemas.parse(e);
  assert.equal(events[0]?.type, "RUN_STARTED");
  const fin = events[events.length - 1] as unknown as { type: string; outcome: { type: string } };
  assert.equal(fin.type, "RUN_FINISHED");
  assert.equal(fin.outcome.type, "success");
  return events as unknown as Array<Record<string, any>>;
}

const sayText = (events: Array<Record<string, any>>) =>
  events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta;
const toolArgs = (events: Array<Record<string, any>>) => {
  const start = events.find((e) => e.type === "TOOL_CALL_START");
  const args = events.find((e) => e.type === "TOOL_CALL_ARGS");
  return { name: start?.toolCallName, id: start?.toolCallId, args: JSON.parse(args?.delta ?? "null") };
};

test("no wake message: nothing to do", () => {
  const ev = run([{ id: "m", role: "user", content: "hello" }]);
  assert.equal(sayText(ev), "Nothing to do.");
});

test("a non-blocked state is noted", () => {
  assert.equal(sayText(run([wakeMsg("completed")])), `Noted: ${ID} is completed.`);
});

test("blocked with no tool results reads the task", () => {
  const t = toolArgs(run([wakeMsg("blocked")]));
  assert.deepEqual(t, { name: "teamkit_read", id: "run_1-read", args: { threadId: ID } });
});

test("needs_input with options answers with the first option", () => {
  const ev = run([
    wakeMsg("blocked"),
    asked("teamkit_read", "c1"),
    readResult({ kind: "needs_input", options: ["pg", "sqlite"] }),
  ]);
  assert.deepEqual(toolArgs(ev), {
    name: "teamkit_answer",
    id: "run_1-answer",
    args: { taskId: ID, choice: "pg" },
  });
});

test("needs_input without options answers with the default text", () => {
  for (const options of [null, []]) {
    const ev = run([wakeMsg("blocked"), asked("teamkit_read", "c1"), readResult({ kind: "needs_input", options })]);
    assert.deepEqual(toolArgs(ev).args, { taskId: ID, text: "Go with your recommendation." });
  }
});

test("awaiting_approval is left for a person", () => {
  const ev = run([wakeMsg("blocked"), asked("teamkit_read", "c1"), readResult({ kind: "awaiting_approval", options: ["approve"] })]);
  assert.equal(sayText(ev), `Approvals need a person; leaving ${ID} for an approver.`);
});

test("no block means already answered", () => {
  const ev = run([wakeMsg("blocked"), asked("teamkit_read", "c1"), readResult(null)]);
  assert.equal(sayText(ev), "Already answered.");
});

test("answer results end the run", () => {
  const ok = run([
    wakeMsg("blocked"),
    asked("teamkit_read", "c1"),
    readResult({ kind: "needs_input", options: ["pg"] }),
    asked("teamkit_answer", "c2"),
    result("c2", { taskId: ID, state: "ready" }),
  ]);
  assert.equal(sayText(ok), `Answered ${ID}.`);
  const bad = run([
    wakeMsg("blocked"),
    asked("teamkit_read", "c1"),
    readResult({ kind: "needs_input", options: ["pg"] }),
    asked("teamkit_answer", "c2"),
    result("c2", { error: { code: "conflict", message: "no" } }),
  ]);
  assert.equal(sayText(bad), `Could not answer ${ID}: conflict`);
});

test("only tool messages after the wake count", () => {
  const ev = run([
    asked("teamkit_read", "old"),
    result("old", { taskId: "x", state: "ready" }),
    wakeMsg("blocked"),
  ]);
  assert.equal(toolArgs(ev).name, "teamkit_read");
});

test("over HTTP: a wake message yields a pending teamkit_read call", async () => {
  const server = serve({ fetch: createExampleApp({}).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const agent = new HttpAgent({
      url: `http://127.0.0.1:${port}/lead`,
      threadId: "th_lead",
      initialMessages: [wakeMsg("blocked")],
    });
    let pending: string[] | undefined;
    const res = await agent.runAgent({ runId: "run_1" }, {
      onRunFinishedEvent: (p) => {
        if (p.outcome === "success") pending = p.pendingToolCallIds;
      },
    });
    assert.deepEqual(pending, ["run_1-read"]);
    const calls = res.newMessages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
    assert.equal(calls[0]?.function.name, "teamkit_read");
    assert.deepEqual(JSON.parse(calls[0]!.function.arguments), { threadId: ID });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("bad input gets a 400 and healthz lists lead", async () => {
  const app = createExampleApp({});
  const res = await app.request("/lead", { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
  const body = (await (await app.request("/healthz")).json()) as { agents: string[] };
  assert.ok(body.agents.includes("lead"));
});

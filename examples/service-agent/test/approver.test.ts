import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createExampleApp } from "../src/app.js";
import { approverEvents } from "../src/approver.js";

const base: RunAgentInput = {
  threadId: "th_1",
  runId: "run_1",
  messages: [{ id: "m1", role: "user", content: "Ship v1.2\nmore detail" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

const resumeWith = (payload: unknown): RunAgentInput => ({
  ...base,
  runId: "run_2",
  resume: [{ interruptId: "approve_run_1", status: "resolved", payload }],
});

test("first run states a plan and interrupts", () => {
  const events = approverEvents(base);
  for (const e of events) EventSchemas.parse(e);
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"],
  );
  assert.equal(
    (events[2] as unknown as { delta: string }).delta,
    'Plan: ship "Ship v1.2". I need approval first.',
  );
  const outcome = (events[4] as unknown as { outcome: any }).outcome;
  assert.equal(outcome.type, "interrupt");
  assert.equal(outcome.interrupts[0].id, "approve_run_1");
  assert.equal(outcome.interrupts[0].reason, "awaiting_approval");
  assert.deepEqual(outcome.interrupts[0].responseSchema.properties.choice.enum, ["approve", "reject"]);
});

test("resume approve ships, reject stops", () => {
  for (const [payload, text, result] of [
    [{ choice: "approve" }, "Shipped.", "shipped"],
    [{ choice: "APPROVE" }, "Shipped.", "shipped"],
    [{ text: "approve" }, "Shipped.", "shipped"],
    [{ choice: "reject" }, "Stopped.", "stopped"],
    [{}, "Stopped.", "stopped"],
  ] as const) {
    const events = approverEvents(resumeWith(payload));
    for (const e of events) EventSchemas.parse(e);
    assert.equal(events[0]?.type, "RUN_STARTED");
    assert.equal((events[2] as unknown as { delta: string }).delta, text);
    const fin = events[4] as unknown as { outcome: { type: string }; result: string };
    assert.equal(fin.outcome.type, "success");
    assert.equal(fin.result, result);
  }
});

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = serve({ fetch: createExampleApp({}).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("over HTTP: interrupt, then resume with a fresh agent", async () => {
  await withServer(async (url) => {
    const messages = [{ id: "m1", role: "user" as const, content: "Ship v1.2" }];
    const first = new HttpAgent({ url: `${url}/approver`, threadId: "th_x", initialMessages: messages });
    let outcome: any;
    await first.runAgent({ runId: "run_1" }, {
      onRunFinishedEvent: ({ event }) => {
        outcome = (event as any).outcome;
      },
    });
    assert.equal(outcome.type, "interrupt");
    assert.equal(outcome.interrupts[0].id, "approve_run_1");

    const second = new HttpAgent({ url: `${url}/approver`, threadId: "th_x", initialMessages: messages });
    const res = await second.runAgent({
      runId: "run_2",
      resume: [{ interruptId: "approve_run_1", status: "resolved", payload: { choice: "approve" } }],
    });
    assert.ok(res.newMessages.some((m) => m.content === "Shipped."));
  });
});

test("bad input gets a 400", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/approver`, { method: "POST", body: "{}" });
    assert.equal(res.status, 400);
  });
});

test("healthz lists approver", async () => {
  const res = await createExampleApp({}).request("/healthz");
  const body = (await res.json()) as { agents: string[] };
  assert.ok(body.agents.includes("approver"));
});

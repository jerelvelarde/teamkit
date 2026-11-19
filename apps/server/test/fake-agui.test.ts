import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { startFakeAgui, steps, type FakeStep } from "./helpers/fake-agui.js";
import { assertAguiValid } from "./helpers/agui.js";

function events(list: FakeStep[]): unknown[] {
  return list.flatMap((s) => ("event" in s ? [s.event] : []));
}

test("text run resolves with the assistant message", async () => {
  const fake = await startFakeAgui((i) => [steps.started(i), ...steps.text("m1", "hi"), steps.success(i)]);
  try {
    const agent = new HttpAgent({ url: fake.url, threadId: "t-1" });
    const { newMessages } = await agent.runAgent();
    const msg = newMessages.find((m) => m.role === "assistant");
    assert.equal(msg?.content, "hi");
    assert.equal(fake.inputs[0]?.threadId, "t-1");
    assert.equal(fake.calls(), 1);
  } finally {
    await fake.stop();
  }
});

test("interrupt, then resume reaches the second run", async () => {
  const fake = await startFakeAgui((i, call) =>
    call === 0
      ? [steps.started(i), steps.interrupt(i, { id: "int-1", reason: "approval", message: "ok?", options: ["approve", "reject"] })]
      : [steps.started(i), steps.success(i, "done")],
  );
  try {
    let interruptId: string | undefined;
    let outcome: string | undefined;
    await new HttpAgent({ url: fake.url, threadId: "t-2" }).runAgent(
      {},
      {
        onRunFinishedEvent(p) {
          outcome = p.outcome;
          if (p.outcome === "interrupt") interruptId = p.interrupts[0]?.id;
        },
      },
    );
    assert.equal(outcome, "interrupt");
    assert.equal(interruptId, "int-1");
    await new HttpAgent({ url: fake.url, threadId: "t-2" }).runAgent({
      resume: [{ interruptId: "int-1", status: "resolved", payload: { choice: "approve" } }],
    });
    assert.equal(fake.inputs[1]?.resume?.[0]?.interruptId, "int-1");
    assert.deepEqual(fake.inputs[1]?.resume?.[0]?.payload, { choice: "approve" });
  } finally {
    await fake.stop();
  }
});

test("tool call then success reports pendingToolCallIds", async () => {
  const fake = await startFakeAgui((i) => [steps.started(i), ...steps.toolCall("tc-1", "ask", { q: 1 }), steps.success(i)]);
  try {
    let pending: string[] | undefined;
    await new HttpAgent({ url: fake.url }).runAgent(
      {},
      {
        onRunFinishedEvent(p) {
          if (p.outcome === "success") pending = p.pendingToolCallIds;
        },
      },
    );
    assert.deepEqual(pending, ["tc-1"]);
  } finally {
    await fake.stop();
  }
});

test("a dropped connection makes runAgent reject", async () => {
  // For 22.1: with HttpAgent 1.0.2 a drop fires onRunFailed AND rejects runAgent (TypeError: fetch failed).
  const fake = await startFakeAgui((i) => [steps.started(i), ...steps.text("m1", "par"), { drop: true }]);
  try {
    let failed = false;
    let rejected = false;
    await new HttpAgent({ url: fake.url }).runAgent({}, { onRunFailed: () => void (failed = true) }).catch(() => void (rejected = true));
    assert.ok(failed || rejected, "drop must surface as a failure");
    assert.ok(failed && rejected);
  } finally {
    await fake.stop();
  }
});

test("delay steps wait and scripted events validate with EventSchemas", async () => {
  const input = { threadId: "t", runId: "r", messages: [], tools: [], context: [], state: {} };
  const all: FakeStep[] = [
    steps.started(input),
    ...steps.text("m", "x"),
    ...steps.toolCall("c", "n", {}),
    steps.success(input),
    steps.success(input, "r"),
    steps.interrupt(input, { id: "i", reason: "r", message: "m" }),
    steps.interrupt(input, { id: "i", reason: "r", message: "m", options: ["a"] }),
    steps.runError("boom", "E"),
    steps.runError("boom"),
  ];
  assertAguiValid(events(all));
  assert.equal("result" in (steps.success(input) as { event: object }).event, false);
  const fake = await startFakeAgui((i) => [{ delayMs: 50 }, steps.started(i), steps.success(i)]);
  try {
    const t0 = Date.now();
    await new HttpAgent({ url: fake.url }).runAgent();
    assert.ok(Date.now() - t0 >= 45);
  } finally {
    await fake.stop();
  }
});

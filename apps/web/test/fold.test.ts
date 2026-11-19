import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  choiceSchema,
  custom,
  runError,
  runFinishedInterrupt,
  runFinishedSuccess,
  runStarted,
  textMessage,
  type AguiEvent,
  type BoardEvent,
} from "@copilotkit/teamkit-protocol";
import { foldEvents } from "../lib/fold.js";

const ada = { id: "act_ada", name: "ada", kind: "person" as const };
const bot = { id: "act_bot", name: "coder", kind: "agent" as const };

let n = 0;
function ev(agui: AguiEvent[], actor: BoardEvent["actor"] = ada): BoardEvent {
  n += 1;
  return {
    cursor: String(n),
    kind: "message.posted",
    room: "r",
    threadId: "t",
    actor,
    agui,
    data: {},
    createdAt: "2026-11-19T00:00:00Z",
  };
}
const raw = (e: Record<string, unknown>): AguiEvent => e as AguiEvent;

describe("foldEvents", () => {
  it("empty input", () => {
    assert.deepEqual(foldEvents([]), { items: [], question: null, lastCursor: "0" });
  });

  it("joins message deltas and takes the actor from metadata", () => {
    const [start, , end] = textMessage({ messageId: "m1", role: "user", text: "", actor: ada });
    const vm = foldEvents([
      ev([start!, raw({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello " })], null),
      ev([raw({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" }), end!], null),
    ]);
    assert.equal(vm.items.length, 1);
    assert.deepEqual(vm.items[0], {
      kind: "message",
      id: "m1",
      role: "user",
      text: "Hello world",
      actor: { name: "ada", kind: "person" },
      streaming: false,
      cursor: "1",
    });
  });

  it("ignores a duplicate start, streams until END, and falls back to the event actor", () => {
    const start = raw({ type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" });
    const vm = foldEvents([ev([start, start, raw({ type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "hi" })], bot)]);
    assert.equal(vm.items.length, 1);
    const m = vm.items[0]!;
    assert.ok(m.kind === "message" && m.streaming && m.text === "hi");
    assert.deepEqual(m.kind === "message" && m.actor, { name: "coder", kind: "agent" });
  });

  it("builds a chunk message and tolerates content with no start", () => {
    const vm = foldEvents([
      ev([raw({ type: "TEXT_MESSAGE_CHUNK", messageId: "c1", delta: "a" })]),
      ev([raw({ type: "TEXT_MESSAGE_CHUNK", messageId: "c1", delta: "b" })]),
      ev([raw({ type: "TEXT_MESSAGE_CONTENT", messageId: "orphan", delta: "x" })]),
      ev([raw({ type: "TEXT_MESSAGE_END", messageId: "never-started" })]),
    ]);
    assert.deepEqual(
      vm.items.map((i) => (i.kind === "message" ? [i.id, i.text] : null)),
      [["c1", "ab"], ["orphan", "x"]],
    );
  });

  it("folds a tool call", () => {
    const vm = foldEvents([
      ev([
        raw({ type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" }),
        raw({ type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"a":' }),
        raw({ type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: "1}" }),
        raw({ type: "TOOL_CALL_END", toolCallId: "tc1" }),
        raw({ type: "TOOL_CALL_RESULT", messageId: "m9", toolCallId: "tc1", content: "ok" }),
        raw({ type: "TOOL_CALL_RESULT", messageId: "m9", toolCallId: "tc2", content: { n: 1 } }),
      ]),
    ]);
    const [t1, t2] = vm.items;
    assert.ok(t1?.kind === "tool" && t1.name === "search" && t1.args === '{"a":1}' && t1.result === "ok");
    assert.ok(t2?.kind === "tool" && t2.result === '{"n":1}');
  });

  it("folds reasoning", () => {
    const vm = foldEvents([
      ev([
        raw({ type: "REASONING_START", messageId: "r1" }),
        raw({ type: "REASONING_MESSAGE_START", messageId: "r1" }),
        raw({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "think" }),
        raw({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "ing" }),
        raw({ type: "REASONING_MESSAGE_END", messageId: "r1" }),
      ]),
    ]);
    assert.equal(vm.items.length, 1);
    assert.ok(vm.items[0]?.kind === "reasoning" && vm.items[0].text === "thinking");
  });

  it("an interrupt sets the question; the answer clears it", () => {
    const vm1 = foldEvents([
      ev([
        ...textMessage({ messageId: "q", role: "assistant", text: "Question (needs_input): db?", actor: bot }),
        runFinishedInterrupt("t", "run1", { id: "int1", reason: "needs_input", message: "db?", responseSchema: choiceSchema(["pg", "sqlite"]) }),
      ], bot),
    ]);
    assert.deepEqual(vm1.question, { interruptId: "int1", reason: "needs_input", message: "db?", options: ["pg", "sqlite"] });
    assert.deepEqual(
      vm1.items.map((i) => i.kind),
      ["message", "status"],
    );
    const waiting = vm1.items[1]!;
    assert.ok(waiting.kind === "status" && waiting.label === "Waiting: db?" && waiting.tone === "warning");

    const vm2 = foldEvents([
      ev([runFinishedInterrupt("t", "run1", { id: "int1", reason: "needs_input", message: "db?", responseSchema: choiceSchema(["pg", "sqlite"]) })], bot),
      ev([custom("teamkit.interrupt.answered", { interruptId: "int1", by: ada, payload: { choice: "pg" } })]),
    ]);
    assert.equal(vm2.question, null);
    const last = vm2.items.at(-1)!;
    assert.ok(last.kind === "status" && last.label === "Answered by ada" && last.tone === "success");
  });

  it("a free-text interrupt has no options; a new run or completion clears it", () => {
    const ask = ev([runFinishedInterrupt("t", "r", { id: "i", reason: "awaiting_approval", message: "ok?" })], bot);
    assert.equal(foldEvents([ask]).question?.options, null);
    assert.equal(foldEvents([ask, ev([runStarted("t", "r2", "clm")])]).question, null);
    assert.equal(foldEvents([ask, ev([runFinishedSuccess("t", "r2", "done")])]).question, null);
    assert.equal(foldEvents([ask, ev([custom("teamkit.task.completed", {})])]).question, null);
  });

  it("handles the blocked custom event", () => {
    const vm = foldEvents([
      ev([custom("teamkit.task.blocked", { interruptId: "i9", kind: "needs_input", question: "which?", options: ["a", "b"] })]),
    ]);
    assert.deepEqual(vm.question, { interruptId: "i9", reason: "needs_input", message: "which?", options: ["a", "b"] });
  });

  it("maps run status events", () => {
    const vm = foldEvents([
      ev([
        runStarted("t", "r", "c"),
        runFinishedSuccess("t", "r", "all done"),
        runError("released", "teamkit.released"),
        runError("x", "teamkit.lease_expired"),
        runError("boom", "teamkit.failed"),
        runError("weird", "other"),
        raw({ type: "RUN_FINISHED", outcome: { type: "cancelled" } }),
      ]),
    ]);
    const s = vm.items.map((i) => (i.kind === "status" ? [i.label, i.tone, i.detail] : null));
    assert.deepEqual(s, [
      ["Run started", "info", null],
      ["Run finished", "success", "all done"],
      ["Released", "neutral", null],
      ["Claim expired", "warning", null],
      ["Failed", "danger", "boom"],
      ["Run error", "danger", "weird"],
      ["Run cancelled", "neutral", null],
    ]);
  });

  it("maps CUSTOM events", () => {
    const vm = foldEvents([
      ev([
        custom("teamkit.task.created", { taskId: "t" }),
        custom("teamkit.task.claimed", { claimId: "c", actor: bot }),
        custom("teamkit.task.ready", {}),
        custom("teamkit.label", { key: "env", value: "prod" }),
        custom("teamkit.task.failed", { reason: "bad" }),
        custom("teamkit.task.released", {}),
        custom("teamkit.trigger.fired", {}),
        custom("teamkit.thread.created", {}),
        custom("teamkit.message.posted", {}),
        custom("teamkit.mystery", {}),
      ]),
    ]);
    assert.deepEqual(
      vm.items.map((i) => (i.kind === "status" ? [i.label, i.tone, i.detail] : null)),
      [
        ["Task created", "info", null],
        ["Claimed by coder", "info", null],
        ["Ready", "info", null],
        ["Label env=prod", "neutral", null],
        ["Failed", "danger", "bad"],
        ["Released", "neutral", null],
        ["Woken by a trigger", "info", null],
        ["teamkit.mystery", "neutral", null],
      ],
    );
  });

  it("groups subagent events", () => {
    const sub = (e: Record<string, unknown>) => raw({ ...e, subagentRunId: "sa1" });
    const vm = foldEvents([
      ev([sub({ type: "SUBAGENT_STARTED", name: "searcher" })]),
      ev([
        sub({ type: "TEXT_MESSAGE_START", messageId: "sm", role: "assistant" }),
        sub({ type: "TEXT_MESSAGE_CONTENT", messageId: "sm", delta: "found it" }),
        sub({ type: "TEXT_MESSAGE_END", messageId: "sm" }),
      ]),
      ev([sub({ type: "SUBAGENT_FINISHED", result: "done" })]),
    ]);
    assert.equal(vm.items.length, 1);
    const g = vm.items[0]!;
    assert.ok(g.kind === "subagent" && g.name === "searcher" && g.status === "finished" && g.detail === "done");
    assert.ok(g.kind === "subagent" && g.items.length === 1 && g.items[0]?.kind === "message");
    const err = foldEvents([
      ev([sub({ type: "SUBAGENT_STARTED", name: "x" }), sub({ type: "SUBAGENT_ERROR", message: "nope" })]),
    ]).items[0]!;
    assert.ok(err.kind === "subagent" && err.status === "error" && err.detail === "nope");
  });

  it("ignores unknown and unrelated types and never throws on garbage", () => {
    const vm = foldEvents([
      ev([
        raw({ type: "WHATEVER" }),
        raw({ type: "STEP_STARTED", stepName: "s" }),
        raw({ type: "STATE_SNAPSHOT", snapshot: {} }),
        raw({ type: "MESSAGES_SNAPSHOT", messages: [] }),
        raw({ type: "RAW", event: {} }),
        raw({ type: "SUBAGENT_FINISHED", subagentRunId: "ghost" }),
        raw({ type: "TOOL_CALL_END", toolCallId: "ghost" }),
        raw({ type: 5 }),
        raw({ type: "CUSTOM" }),
        raw({ type: "TEXT_MESSAGE_CONTENT", delta: 1 }),
        raw({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [null, 3] } }),
      ]),
      { cursor: "77", agui: null } as unknown as BoardEvent,
      null as unknown as BoardEvent,
      { cursor: "78", agui: [null, "x", 4] } as unknown as BoardEvent,
    ]);
    assert.equal(vm.items.length, 1); // only the empty "Waiting" status
    assert.equal(vm.question, null);
    assert.equal(vm.lastCursor, "78");
    assert.doesNotThrow(() => foldEvents(undefined as unknown as BoardEvent[]));
  });

  it("lastCursor is the last event's cursor", () => {
    const events = [ev([runStarted("t", "r", "c")]), ev([])];
    assert.equal(foldEvents(events).lastCursor, events[1]!.cursor);
  });
});

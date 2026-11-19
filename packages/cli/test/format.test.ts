import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActorRef, BoardEvent, RoomView, Task, ThreadView } from "@copilotkit/teamkit-protocol";
import { firstLine, formatEvent, formatRoom, formatTask, formatTaskList, formatThread } from "../src/format.js";

const actor: ActorRef = { id: "ac_1", name: "ada", kind: "agent" };

function task(over: Partial<Task> = {}): Task {
  return {
    id: "th_1",
    room: "eng",
    state: "ready",
    brief: "Fix the build\nmore detail",
    labels: {},
    needs: [],
    needStates: {},
    target: null,
    claim: null,
    block: null,
    pendingResume: null,
    attempts: 0,
    result: null,
    createdBy: actor,
    createdAt: "2026-11-19T00:00:00Z",
    updatedAt: "2026-11-19T00:00:00Z",
    ...over,
  };
}

test("firstLine truncates and takes only the first line", () => {
  assert.equal(firstLine("short"), "short");
  assert.equal(firstLine("a\nb"), "a");
  assert.equal(firstLine("abcdef", 3), "abc…");
  assert.equal(firstLine("x".repeat(80)), "x".repeat(80));
  assert.equal(firstLine("x".repeat(81)), `${"x".repeat(80)}…`);
});

test("formatTask ready with labels", () => {
  assert.equal(formatTask(task({ labels: { a: "1", b: "2" } })), "th_1  [ready]  eng  Fix the build labels a=1,b=2");
});

test("formatTask claimed", () => {
  const s = formatTask(
    task({ state: "claimed", claim: { id: "cl_1", actor, leaseExpiresAt: "2026-11-19T01:00:00Z" } }),
  );
  assert.match(s, /claimed by ada until 2026-11-19T01:00:00Z$/);
});

test("formatTask blocked", () => {
  const s = formatTask(
    task({
      state: "blocked",
      block: { interruptId: "i1", kind: "needs_input", question: "Which env?", options: null, blockedBy: actor },
    }),
  );
  assert.match(s, /\[blocked\].*blocked: Which env\?$/);
});

test("formatTask waiting shows a failed need", () => {
  const s = formatTask(
    task({ state: "waiting", needs: ["th_2", "th_3"], needStates: { th_2: "failed", th_3: "completed" } }),
  );
  assert.ok(s.includes("needs: th_2(failed),th_3(completed)"));
  assert.ok(s.includes("(failed)"));
});

test("formatTaskList", () => {
  assert.equal(formatTaskList([]), "no tasks");
  assert.equal(formatTaskList([task(), task({ id: "th_2" })]).split("\n").length, 2);
});

test("formatEvent with null thread and actor", () => {
  const e: BoardEvent = {
    cursor: "7",
    kind: "task.created",
    room: "eng",
    threadId: null,
    actor: null,
    agui: [],
    data: {},
    createdAt: "2026-11-19T00:00:00Z",
  };
  assert.equal(formatEvent(e), "7  task.created  eng  -  system");
  assert.equal(formatEvent({ ...e, threadId: "th_1", actor }), "7  task.created  eng  th_1  ada");
});

test("formatThread and formatRoom include names and contents", () => {
  const info = { id: "th_1", room: "eng", isTask: true, labels: {}, createdBy: actor, createdAt: "t" };
  const tv = {
    thread: info,
    task: task(),
    messages: [
      { id: "m1", role: "user", name: "ada", content: "hello there" },
      { id: "m2", role: "assistant", content: "hi back" },
    ],
    cursor: "3",
  } as ThreadView;
  const out = formatThread(tv);
  assert.ok(out.startsWith("th_1  eng  [ready]"));
  assert.ok(out.includes("ada: hello there"));
  assert.ok(out.includes("assistant: hi back"));

  const rv: RoomView = {
    room: { name: "eng", createdAt: "t", agent: null, approvers: null, slackChannel: null, slackAnnounce: "none" },
    threads: [{ ...info, state: "ready", brief: "Fix the build" }, { ...info, id: "th_2", isTask: false, state: null, brief: null }],
    cursor: "3",
  };
  const r = formatRoom(rv);
  assert.ok(r.startsWith("eng\n"));
  assert.ok(r.includes("th_1  [ready]  Fix the build"));
  assert.ok(r.includes("th_2  [discussion]"));
});

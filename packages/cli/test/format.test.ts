import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActorRef, BoardEvent, Decision, Pending, RoomView, Task, ThreadView } from "@copilotkit/teamkit-protocol";
import { firstLine, formatEvent, formatPending, formatPresence, formatRoom, formatTask, formatTaskList, formatThread } from "../src/format.js";

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
    reservedFor: null,
    reservedUntil: null,
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
      block: { interruptId: "i1", kind: "needs_input", question: "Which env?", options: null, blockedBy: actor, approvers: null },
    }),
  );
  assert.match(s, /\[blocked\].*blocked \(needs_input\): Which env\?$/);
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
    room: { name: "eng", createdAt: "t", agent: null, approvers: null, slackChannel: null, slackAnnounce: "none", reservationMinutes: 30 },
    threads: [{ ...info, state: "ready", brief: "Fix the build" }, { ...info, id: "th_2", isTask: false, state: null, brief: null }],
    cursor: "3",
  };
  const r = formatRoom(rv);
  assert.ok(r.startsWith("eng\n"));
  assert.ok(r.includes("th_1  [ready]  Fix the build"));
  assert.ok(r.includes("th_2  [discussion]"));
});

test("formatThread prints labels, needs, block, result and cursor; formatTask shows kind and options", () => {
  const info = { id: "th_1", room: "eng", isTask: true, labels: {}, createdBy: actor, createdAt: "t" };
  const block = { interruptId: "i", kind: "needs_input" as const, question: "which?", options: ["a", "b"], blockedBy: actor, approvers: null };
  const blocked = task({ state: "blocked", labels: { role: "worker" }, needs: ["th_0"], needStates: { th_0: "completed" }, block });
  const out = formatThread({ thread: info, task: blocked, messages: [], cursor: "7" } as ThreadView);
  assert.ok(out.includes("labels: role=worker"));
  assert.ok(out.includes("needs: th_0(completed)"));
  assert.ok(out.includes("blocked (needs_input): which? [options: a|b]"));
  assert.ok(out.endsWith("cursor: 7"));
  assert.ok(formatTask(blocked).includes("blocked (needs_input): which? [options: a|b]"));
  const done = formatThread({ thread: info, task: task({ state: "completed", result: "shipped" }), messages: [], cursor: "8" } as ThreadView);
  assert.ok(done.includes("result: shipped"));
});

const benAgentRef: ActorRef = { id: "ac_2", name: "ben-agent", kind: "agent" };

test("formatTask names who a block waits on", () => {
  const block = { interruptId: "i", kind: "awaiting_approval" as const, question: "Run the backfill on billing-prod?",
    options: null, blockedBy: benAgentRef, approvers: ["sam"] };
  assert.match(formatTask(task({ state: "blocked", block })), /blocked \(awaiting_approval\): Run the backfill on billing-prod\? \(waiting on sam\)$/);
});

test("formatTask shows who a task is held for", () => {
  assert.match(formatTask(task({ reservedFor: benAgentRef, reservedUntil: "2026-11-19T10:30:00.000Z" })),
    / held for ben-agent until 2026-11-19T10:30:00\.000Z$/);
});

test("formatPresence shows on/off, sessions, watching and status", () => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const list = [{
    actor: benAgentRef,
    owner: { id: "ac_ben", name: "ben", kind: "person" as const },
    sessions: [
      { tokenId: "tok_1", watching: ["billing-migration"], status: "idle", lastSeenAt: iso(-10_000) },
      { tokenId: "tok_2", watching: ["billing-prod"], status: null, lastSeenAt: iso(-60_000) },
    ],
  }];
  assert.equal(formatPresence(list, now),
    `ben-agent  ben  on  2 sessions  last seen ${iso(-10_000)}  watching billing-migration,billing-prod  idle`);
  assert.match(formatPresence(list, now + 120_000), /^ben-agent  ben  off  /);
  assert.equal(formatPresence([], now), "no agents");
});

test("formatPending: full, brief, empty and capped", () => {
  const sam: ActorRef = { id: "ac_sam", name: "sam", kind: "person" };
  const empty: Pending = { handoffs: [], answered: [], decisions: [], rollCalls: [], asks: [] };
  assert.equal(formatPending(empty, { brief: false }), "nothing waiting");
  assert.equal(formatPending(empty, { brief: true }), "");
  const handoff = task({ room: "billing-migration", brief: "Write the cutover runbook", reservedFor: benAgentRef,
    reservedUntil: "2026-11-19T10:30:00.000Z" });
  const decision: Decision = { id: "dec_1", room: "billing-migration", threadId: "th_9", text: "Freeze writes to invoices_v1 from 14:00 UTC",
    decidedBy: sam, postedBy: sam, createdAt: "2026-11-19T10:00:00.000Z", acks: [] };
  const two = { ...empty, handoffs: [handoff], decisions: [decision] };
  assert.equal(formatPending(two, { brief: true }),
    "TeamKit: 2 waiting for you\n" +
    "handoff  th_1  billing-migration  Write the cutover runbook  (held until 2026-11-19T10:30:00.000Z)\n" +
    "decision  dec_1  billing-migration  Freeze writes to invoices_v1 from 14:00 UTC  (by sam)");
  const answered = task({ id: "th_2", room: "billing-prod", brief: "Backfill invoices_v2 from invoices_v1",
    pendingResume: [{ interruptId: "int_1", status: "resolved", payload: { choice: "approve" } }] });
  const rollCall = { id: "rc_1", room: "billing-migration", threadId: "th_8", askedBy: sam, createdAt: "2026-11-19T10:00:00.000Z", answers: [] };
  const ask = task({ id: "th_3", room: "billing-prod", state: "blocked",
    block: { interruptId: "int_2", kind: "awaiting_approval", question: "Run the backfill on billing-prod?", options: ["approve", "reject"],
      blockedBy: benAgentRef, approvers: null } });
  assert.equal(formatPending({ handoffs: [], answered: [answered], decisions: [], rollCalls: [rollCall], asks: [ask] }, { brief: false }),
    "answered  th_2  billing-prod  Backfill invoices_v2 from invoices_v1  (answer: approve)\n" +
    "rollcall  rc_1  billing-migration  (asked by sam)\n" +
    "ask  th_3  billing-prod  awaiting_approval: Run the backfill on billing-prod?");
  const asks = Array.from({ length: 12 }, (_, i) => ({ ...ask, id: `th_a${i}` }));
  const lines = formatPending({ ...empty, asks }, { brief: true }).split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "TeamKit: 12 waiting for you");
  assert.equal(lines[10], "ask  th_a9  billing-prod  awaiting_approval: Run the backfill on billing-prod?");
  assert.equal(lines[11], "… and 2 more (run: teamkit pending)");
});

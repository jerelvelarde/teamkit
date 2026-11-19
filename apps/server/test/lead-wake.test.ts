import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardEvent, Task } from "@copilotkit/teamkit-protocol";
import { agentAuthContext, registerAgent } from "../src/dispatch/registry.js";
import { ensureLeadThread, wakeLead, wakeText } from "../src/triggers/lead.js";
import { block } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { getThread } from "../src/store/threads.js";
import { agentAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { withTestDb } from "./helpers/db.js";
import { startFakeAgui, steps, type FakeScript } from "./helpers/fake-agui.js";

const text = (m: { content?: unknown }) => (typeof m.content === "string" ? m.content : "");

test("wakeText: exact format for a task, a clipped first line, and a non-task event", () => {
  const event = { cursor: "7", kind: "task.blocked", room: "build", threadId: "th_1", data: { state: "blocked" } } as unknown as BoardEvent;
  const task = { id: "th_1", state: "ready", brief: "Pick a database\nmore detail" } as Task;
  assert.equal(wakeText(event, task), "Task th_1 in build is now blocked: Pick a database. Read it with teamkit_read.");
  assert.equal(
    wakeText({ ...event, data: {} } as BoardEvent, task),
    "Task th_1 in build is now ready: Pick a database. Read it with teamkit_read.",
  );
  assert.match(wakeText(event, { ...task, brief: "x".repeat(300) } as Task), new RegExp(`: x{120}\\. Read it`));
  assert.equal(wakeText({ ...event, kind: "message.posted" } as BoardEvent, null), "Event message.posted in build.");
});

test("a lead wake-up answers a blocked task through its board tools; the thread is reused", async () => {
  await withTestDb(async (db) => {
    let taskId = "";
    const script: FakeScript = (i, call) => {
      if (call === 0) return [steps.started(i), ...steps.toolCall("tc1", "teamkit_read", { threadId: taskId }), steps.success(i)];
      if (call === 1) {
        return [steps.started(i), ...steps.toolCall("tc2", "teamkit_answer", { taskId, choice: "pg" }), steps.success(i)];
      }
      return [steps.started(i), ...steps.text("m1", "Answered."), steps.success(i)];
    };
    const fake = await startFakeAgui(script);
    try {
      const lead = await registerAgent(db, { name: "lead", url: fake.url, rooms: ["build"] });
      const worker = await agentAuth(db, "worker");
      ({ id: taskId } = await createTask(db, worker, { room: "build", brief: "Pick a database" }));
      const claim = await claimTask(db, worker, taskId);
      await block(db, worker, taskId, claim.claimId, { question: "Which database?", kind: "needs_input", options: ["pg", "sqlite"] });
      const blockedEvent = (await listEvents(db, { threadId: taskId })).events.find((e) => e.kind === "task.blocked")!;

      const outcome = await wakeLead(db, { agent: lead, room: "build", event: blockedEvent, triggerId: "trg_1" });
      assert.equal(outcome.type, "success");

      const task = (await loadTask(db, taskId))!;
      assert.equal(task.state, "ready");
      assert.equal(task.pendingResume?.[0]?.payload?.choice, "pg");

      const [room] = await db`select lead_thread_id from rooms where name = 'build'`;
      const threadId = room!.lead_thread_id as string;
      assert.ok(threadId);
      const wake = `Task ${taskId} in build is now blocked: Pick a database. Read it with teamkit_read.`;
      const { messages } = await getThread(db, agentAuthContext(lead), threadId);
      const bodies = messages.map(text);
      assert.ok(bodies.includes(wake));
      assert.ok(bodies.includes("Answered."));

      const last = fake.inputs[0]!.messages.at(-1)!;
      assert.equal(last.role, "user");
      assert.equal(text(last), wake);
      assert.equal(fake.inputs[0]!.threadId, threadId);

      // The wake-up event carries the trigger marker; no claim or task event was written on the lead thread.
      const evs = (await listEvents(db, { threadId })).events;
      const posted = evs.find((e) => e.kind === "message.posted" && e.data.triggerId === "trg_1")!;
      assert.ok(posted.agui.some((a) => a.type === "CUSTOM" && a.name === "teamkit.trigger.fired"));
      assert.equal(evs.some((e) => e.kind.startsWith("task.")), false);
      assertAguiValid(evs.flatMap((e) => e.agui));

      // A second wake reuses the thread.
      assert.equal(await ensureLeadThread(db, lead, "build"), threadId);
      await wakeLead(db, { agent: lead, room: "build", event: blockedEvent, triggerId: "trg_2" });
      const [again] = await db`select lead_thread_id from rooms where name = 'build'`;
      assert.equal(again!.lead_thread_id, threadId);
      const [n] = await db`select count(*)::int as n from threads where room = 'build' and not is_task`;
      assert.equal(n!.n, 1);
    } finally {
      await fake.stop();
    }
  });
});

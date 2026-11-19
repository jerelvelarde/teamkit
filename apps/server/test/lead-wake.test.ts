import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardEvent, Task } from "@copilotkit/teamkit-protocol";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { agentAuthContext, registerAgent } from "../src/dispatch/registry.js";
import { LEAD_HISTORY_MAX, ensureLeadThread, findLeadThread, wakeLead, wakeText } from "../src/triggers/lead.js";
import { block } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { appendMessage } from "../src/store/rows.js";
import { getThread } from "../src/store/threads.js";
import { agentAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createTestDatabase, withTestDb } from "./helpers/db.js";
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

      const threadId = (await findLeadThread(db, lead, "build"))!;
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
      assert.equal(await findLeadThread(db, lead, "build"), threadId);
      const [n] = await db`select count(*)::int as n from threads where room = 'build' and not is_task`;
      assert.equal(n!.n, 1);
    } finally {
      await fake.stop();
    }
  });
});

test("each lead agent has its own lead thread in a room", async () => {
  await withTestDb(async (db) => {
    const fake = await startFakeAgui((i, call) => [steps.started(i), ...steps.text(`m${call}`, "Seen."), steps.success(i)]);
    try {
      const a = await registerAgent(db, { name: "lead-a", url: fake.url, rooms: ["build", "ops"] });
      const b = await registerAgent(db, { name: "lead-b", url: fake.url, rooms: ["build"] });
      const event = { cursor: "1", kind: "message.posted", room: "build", threadId: null, data: {} } as unknown as BoardEvent;
      await wakeLead(db, { agent: a, room: "build", event, triggerId: "trg_a" });
      await wakeLead(db, { agent: b, room: "build", event, triggerId: "trg_b" });
      await wakeLead(db, { agent: a, room: "ops", event: { ...event, room: "ops" }, triggerId: "trg_a" });

      const aBuild = (await findLeadThread(db, a, "build"))!;
      const bBuild = (await findLeadThread(db, b, "build"))!;
      const aOps = (await findLeadThread(db, a, "ops"))!;
      assert.equal(new Set([aBuild, bBuild, aOps]).size, 3);
      assert.deepEqual(fake.inputs.map((i) => i.threadId), [aBuild, bBuild, aOps]);
      // lead-b's run saw only its own thread: no wake-up of lead-a's.
      const bodies = fake.inputs[1]!.messages.map(text);
      assert.deepEqual(bodies, ["Lead thread for lead-b in build. TeamKit posts wake-ups here.", "Event message.posted in build."]);
      assert.equal(await ensureLeadThread(db, b, "build"), bBuild);
    } finally {
      await fake.stop();
    }
  });
});

test(`a wake-up sends at most the last ${LEAD_HISTORY_MAX} messages, never opening on a tool result`, async () => {
  await withTestDb(async (db) => {
    const fake = await startFakeAgui((i) => [steps.started(i), ...steps.text("m1", "Seen."), steps.success(i)]);
    try {
      const lead = await registerAgent(db, { name: "lead", url: fake.url, rooms: ["build"] });
      const threadId = await ensureLeadThread(db, lead, "build");
      // 20 rounds of user, assistant tool call, tool result: 61 messages with the opening one.
      await db.begin(async (tx) => {
        for (let n = 0; n < 20; n++) {
          await appendMessage(tx, threadId, { id: `u${n}`, role: "user", content: `ask ${n}` });
          await appendMessage(tx, threadId, {
            id: `a${n}`,
            role: "assistant",
            toolCalls: [{ id: `tc${n}`, type: "function", function: { name: "teamkit_read", arguments: "{}" } }],
          });
          await appendMessage(tx, threadId, { id: `t${n}`, role: "tool", toolCallId: `tc${n}`, content: "{}" });
        }
      });
      const event = { cursor: "1", kind: "message.posted", room: "build", threadId: null, data: {} } as unknown as BoardEvent;
      await wakeLead(db, { agent: lead, room: "build", event, triggerId: "trg_1" });

      const sent = fake.inputs[0]!.messages;
      // The last 50 of 62 open on a tool result (t3), whose call was cut off: it is dropped.
      assert.equal(sent.length, LEAD_HISTORY_MAX - 1);
      assert.equal(sent[0]!.role, "user");
      assert.equal(text(sent[0]!), "ask 4");
      assert.equal(text(sent.at(-1)!), "Event message.posted in build.");
    } finally {
      await fake.stop();
    }
  });
});

test("migrating keeps a room's shared lead thread for the agent that opened it", async () => {
  const t = await createTestDatabase({ migrate: false });
  const before = await mkdtemp(join(tmpdir(), "teamkit-migrations-"));
  try {
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < "007") await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    }
    await migrate(t.db, before);
    await t.db`insert into actors (id, kind, name) values ('ac_lead', 'agent', 'lead')`;
    await t.db`insert into rooms (name) values ('build'), ('ops')`;
    await t.db`insert into threads (id, room, is_task, created_by) values ('th_lead', 'build', false, 'ac_lead')`;
    await t.db`update rooms set lead_thread_id = 'th_lead' where name = 'build'`;

    await migrate(t.db);
    assert.deepEqual(
      [...(await t.db`select room, agent_id, thread_id from lead_threads`)],
      [{ room: "build", agent_id: "ac_lead", thread_id: "th_lead" }],
    );
  } finally {
    await rm(before, { recursive: true, force: true });
    await t.drop();
  }
});

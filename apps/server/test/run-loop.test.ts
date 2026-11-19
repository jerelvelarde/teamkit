import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_TOOL_NAMES, type AguiEvent, type BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { agentAuthContext, registerAgent } from "../src/dispatch/registry.js";
import { runAgentLoop, type RunLoopOptions } from "../src/dispatch/run-loop.js";
import { claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { createTask } from "../src/store/tasks.js";
import { getThread, post } from "../src/store/threads.js";
import { agentAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { withTestDb } from "./helpers/db.js";
import { startFakeAgui, steps, type FakeScript } from "./helpers/fake-agui.js";

type Fake = Awaited<ReturnType<typeof startFakeAgui>>;

/** A registered agent pointing at a scripted fake, and a task it has claimed without opening a run. */
interface LoopCtx {
  db: Db;
  fake: Fake;
  opts: (extra?: Partial<RunLoopOptions>) => RunLoopOptions;
  taskId: string;
  claimId: string;
  actorId: string;
}

async function withLoop(script: FakeScript, fn: (ctx: LoopCtx) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const fake = await startFakeAgui(script);
    try {
      const agent = await registerAgent(db, { name: "fake", url: fake.url, rooms: ["research"] });
      const auth = agentAuthContext(agent);
      const lead = await agentAuth(db, "lead");
      const task = await createTask(db, lead, { room: "research", brief: "look into it" });
      const { claimId } = await claimTask(db, auth, task.id, { opensRun: false });
      const messages = (await getThread(db, auth, task.id)).messages;
      const opts = (extra: Partial<RunLoopOptions> = {}): RunLoopOptions => ({
        db,
        agent,
        auth,
        threadId: task.id,
        room: "research",
        messages,
        context: [{ description: "TeamKit task", value: JSON.stringify({ taskId: task.id }) }],
        claimId,
        taskId: task.id,
        ...extra,
      });
      await fn({ db, fake, opts, taskId: task.id, claimId, actorId: agent.actor.id });
    } finally {
      await fake.stop();
    }
  });
}

/** The thread's run.event rows; checks every logged event is valid AG-UI. */
async function runEvents(db: Db, threadId: string): Promise<BoardEvent[]> {
  const { events } = await listEvents(db, { threadId, kinds: ["run.event"] });
  assertAguiValid(events.flatMap((e) => e.agui));
  return events;
}

const first = (e: BoardEvent) => e.agui[0] as AguiEvent;
const types = (events: BoardEvent[]): string[] => events.map((e) => first(e).type);

test("text then success: logged in stream order, assistant message stored", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.text("m1", "done"), steps.success(i)],
    async ({ db, fake, opts, taskId, claimId, actorId }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "success", result: "done", delivered: true });

      const input = fake.inputs[0]!;
      assert.equal(input.threadId, taskId);
      assert.deepEqual(input.tools.map((t) => t.name), [...BOARD_TOOL_NAMES]);
      assert.deepEqual(input.context, [{ description: "TeamKit task", value: JSON.stringify({ taskId }) }]);
      assert.deepEqual(input.forwardedProps, {});
      assert.equal(input.resume, undefined);
      assert.ok(input.messages.some((m) => m.role === "user" && m.content === "look into it"));

      const events = await runEvents(db, taskId);
      assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
      for (let k = 1; k < events.length; k++) assert.ok(BigInt(events[k]!.cursor) > BigInt(events[k - 1]!.cursor));
      assert.deepEqual((first(events[0]!).metadata as Record<string, unknown>).teamkit, { claimId, agent: "fake" });
      for (const e of events) {
        assert.equal(e.actor?.id, actorId);
        assert.deepEqual(e.data, { runId: input.runId, agent: "fake", round: 1, claimId, taskId });
      }

      const last = (await getThread(db, opts().auth, taskId)).messages.at(-1) as Record<string, unknown>;
      assert.equal(last.role, "assistant");
      assert.equal(last.content, "done");
      assert.equal(last.name, "fake");
      assert.deepEqual((last.metadata as Record<string, unknown>).teamkit, { actorId, actorName: "fake", actorKind: "agent" });
    },
  );
});

test("RUN_FINISHED.result wins over the last assistant text; non-strings are JSON", async () => {
  await withLoop(
    (i, call) => [
      steps.started(i),
      ...steps.text(`m${call}`, "said"),
      call === 0
        ? steps.success(i, "the result")
        : { event: { type: "RUN_FINISHED", threadId: i.threadId, runId: i.runId, outcome: { type: "success" }, result: { n: 1 } } },
    ],
    async ({ opts }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "success", result: "the result", delivered: true });
      assert.deepEqual(await runAgentLoop(opts()), { type: "success", result: '{"n":1}', delivered: true });
    },
  );
});

test("a board tool call runs as the agent and its result goes to the next run", async () => {
  await withLoop(
    (i, call) =>
      call === 0
        ? [steps.started(i), ...steps.toolCall("tc1", "teamkit_reply", { threadId: i.threadId, text: "hi" }), steps.success(i)]
        : [steps.started(i), ...steps.text("m2", "ok"), steps.success(i)],
    async ({ db, fake, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "success", result: "ok", delivered: true });
      assert.equal(fake.calls(), 2);

      const toolMsg = fake.inputs[1]!.messages.find((m) => m.role === "tool") as Record<string, unknown> | undefined;
      assert.equal(toolMsg?.toolCallId, "tc1");
      assert.equal(toolMsg?.content, '{"ok":true}');

      const msgs = (await getThread(db, opts().auth, taskId)).messages as Record<string, unknown>[];
      const tail = msgs.slice(-4);
      assert.deepEqual(tail.map((m) => m.role), ["assistant", "assistant", "tool", "assistant"]);
      assert.equal((tail[0]!.toolCalls as { id: string }[])[0]!.id, "tc1");
      assert.equal(tail[1]!.content, "hi");
      assert.equal(tail[2]!.toolCallId, "tc1");
      assert.equal(tail[3]!.content, "ok");

      const events = await runEvents(db, taskId);
      const results = events.filter((e) => first(e).type === "TOOL_CALL_RESULT");
      assert.equal(results.length, 1);
      const r = first(results[0]!);
      assert.equal(r.toolCallId, "tc1");
      assert.equal(r.content, '{"ok":true}');
      assert.equal(r.role, "tool");
      assert.equal(r.messageId, tail[2]!.id);
      assert.equal(results[0]!.data.runId, fake.inputs[0]!.runId);
      assert.equal(results[0]!.data.round, 1);
      assert.deepEqual(
        events.map((e) => e.data.round),
        [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
      );
    },
  );
});

test("resume is sent on the first run only", async () => {
  const resume = [{ interruptId: "int0", status: "resolved" as const, payload: { choice: "approve" } }];
  await withLoop(
    (i, call) =>
      call === 0
        ? [steps.started(i), ...steps.toolCall("tc1", "teamkit_read", { threadId: i.threadId }), steps.success(i)]
        : [steps.started(i), steps.success(i, "fine")],
    async ({ fake, opts }) => {
      assert.deepEqual(await runAgentLoop(opts({ resume })), { type: "success", result: "fine", delivered: true });
      assert.deepEqual(fake.inputs[0]!.resume, resume);
      assert.equal(fake.inputs[1]!.resume, undefined);
    },
  );
});

test("interrupt maps to its id, reason, message and options", async () => {
  await withLoop(
    (i, call) => [
      steps.started(i),
      call === 0
        ? steps.interrupt(i, { id: "int1", reason: "approval", message: "ok?", options: ["approve", "reject"] })
        : steps.interrupt(i, { id: "int2", reason: "input", message: "which?" }),
    ],
    async ({ db, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts()), {
        type: "interrupt",
        interrupt: { id: "int1", reason: "approval", message: "ok?", options: ["approve", "reject"] },
        delivered: true,
      });
      assert.deepEqual(await runAgentLoop(opts()), {
        type: "interrupt",
        interrupt: { id: "int2", reason: "input", message: "which?", options: null },
        delivered: true,
      });
      await runEvents(db, taskId);
    },
  );
});

test("RUN_ERROR is an agent error; text before it is kept", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.text("m1", "partial"), steps.runError("boom", "E1")],
    async ({ db, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "agent_error", message: "boom", code: "E1", delivered: true });
      assert.equal(types(await runEvents(db, taskId)).at(-1), "RUN_ERROR");
      assert.equal((await getThread(db, opts().auth, taskId)).messages.at(-1)?.content, "partial");
    },
  );
});

test("a dropped stream is one transport error, not delivered, with no partial message stored", async () => {
  // Call 0 drops at once (the client may never read a frame); call 1 drops after the frames arrived.
  await withLoop(
    (i, call) => [steps.started(i), ...steps.text("m1", "par"), ...(call === 0 ? [] : [{ delayMs: 50 }]), { drop: true }],
    async ({ db, fake, opts, taskId }) => {
      const resume = [{ interruptId: "int0", status: "resolved" as const, payload: {} }];
      for (const call of [0, 1]) {
        const out = await runAgentLoop(opts({ resume }));
        assert.equal(out.type, "transport_error");
        assert.equal(out.delivered, false);
        assert.ok(out.type === "transport_error" && out.message.length > 0);
        assert.equal(fake.calls(), call + 1);
      }
      assert.deepEqual(types(await runEvents(db, taskId)).slice(-4), [
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
      ]);
      assert.equal((await getThread(db, opts().auth, taskId)).messages.some((m) => m.content === "par"), false);
    },
  );
});

test("a stream that breaks after RUN_FINISHED keeps the run's outcome", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.text("m1", "done"), steps.success(i), { delayMs: 50 }, { drop: true }],
    async ({ db, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "success", result: "done", delivered: true });
      assert.equal((await getThread(db, opts().auth, taskId)).messages.at(-1)?.content, "done");
    },
  );
});

test("a stream that ends without RUN_FINISHED is a transport error", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.text("m1", "par")],
    async ({ opts }) => {
      const out = await runAgentLoop(opts());
      assert.deepEqual(out, {
        type: "transport_error",
        message: "the agent's stream ended without RUN_FINISHED or RUN_ERROR",
        delivered: false,
      });
    },
  );
});

test("a pending call to a tool the board does not provide is unknown_tool", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.toolCall("tc1", "weather", { city: "x" }), steps.success(i)],
    async ({ db, fake, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts()), { type: "unknown_tool", names: ["weather"], delivered: true });
      assert.equal(fake.calls(), 1);
      assert.equal(types(await runEvents(db, taskId)).includes("TOOL_CALL_RESULT"), false);
    },
  );
});

test("board-tool rounds are capped per loop", async () => {
  await withLoop(
    (i, call) => [steps.started(i), ...steps.toolCall(`tc${call}`, "teamkit_read", { threadId: i.threadId }), steps.success(i)],
    async ({ db, fake, opts, taskId }) => {
      assert.deepEqual(await runAgentLoop(opts({ maxRounds: 3 })), { type: "too_many_rounds", delivered: true });
      assert.equal(fake.calls(), 3);
      const results = (await runEvents(db, taskId)).filter((e) => first(e).type === "TOOL_CALL_RESULT");
      assert.deepEqual(results.map((e) => first(e).toolCallId), ["tc0", "tc1", "tc2"]);
      assert.equal(JSON.parse(first(results[0]!).content as string).thread.id, taskId);
    },
  );
});

test("aborting the signal ends the loop as aborted without logging the client's own RUN_ERROR", async () => {
  await withLoop(
    (i) => [steps.started(i), { delayMs: 2000 }, ...steps.text("m1", "late"), steps.success(i)],
    async ({ db, fake, opts, taskId }) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const t0 = Date.now();
      assert.deepEqual(await runAgentLoop(opts({ signal: ac.signal })), { type: "aborted", delivered: false });
      assert.ok(Date.now() - t0 < 1500);
      assert.deepEqual(types(await runEvents(db, taskId)), ["RUN_STARTED"]);

      assert.deepEqual(await runAgentLoop(opts({ signal: ac.signal })), { type: "aborted", delivered: false });
      assert.equal(fake.calls(), 1);
    },
  );
});

test("a run on a thread that is not a task carries no claim", async () => {
  await withLoop(
    (i) => [steps.started(i), ...steps.text("m1", "noted"), steps.success(i)],
    async ({ db, opts }) => {
      const { threadId } = await post(db, opts().auth, { room: "research", text: "fyi" });
      const out = await runAgentLoop(opts({ threadId, claimId: undefined, taskId: undefined, messages: [] }));
      assert.deepEqual(out, { type: "success", result: "noted", delivered: true });
      const events = await runEvents(db, threadId);
      assert.deepEqual((first(events[0]!).metadata as Record<string, unknown>).teamkit, { agent: "fake" });
      assert.equal("claimId" in events[0]!.data, false);
      assert.equal("taskId" in events[0]!.data, false);
      assert.equal((await getThread(db, opts().auth, threadId)).messages.at(-1)?.content, "noted");
    },
  );
});

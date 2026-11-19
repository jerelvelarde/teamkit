import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { BoardEvent, Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { startDispatcher, type Dispatcher, type DispatcherOptions } from "../src/dispatch/dispatcher.js";
import { registerAgent, type RegisteredAgent } from "../src/dispatch/registry.js";
import { createNotifier } from "../src/notifier.js";
import { answer } from "../src/store/blocks.js";
import { listEvents } from "../src/store/events.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { withTestDb } from "./helpers/db.js";
import { startFakeAgui, steps, type FakeScript } from "./helpers/fake-agui.js";

type Fake = Awaited<ReturnType<typeof startFakeAgui>>;

interface DispatchCtx {
  db: Db;
  fake: Fake;
  agent: RegisteredAgent;
  logs: string[];
  /** A dispatcher with pollMs 100 and retryDelayMs 50 unless overridden; stopped after the test. */
  start(extra?: Partial<DispatcherOptions>): Dispatcher;
  /** A ready task created by another agent's token. */
  create(room: string, labels?: Record<string, string>): Promise<string>;
  task(id: string): Promise<Task>;
  events(id: string): Promise<BoardEvent[]>;
  /** Runs the fake was asked for on this task's thread. */
  calls(id: string): number;
}

/** Every RUN_FINISHED or RUN_ERROR in a thread's log closes an open run, and none is left open. */
function assertRunsBalanced(log: BoardEvent[]): void {
  let open = false;
  for (const e of log) {
    for (const a of e.agui) {
      if (a.type === "RUN_STARTED") {
        assert.ok(!open, `${e.kind} at ${e.cursor}: RUN_STARTED inside an open run`);
        open = true;
      } else if (a.type === "RUN_FINISHED" || a.type === "RUN_ERROR") {
        assert.ok(open, `${e.kind} at ${e.cursor}: ${a.type} with no open run`);
        open = false;
      }
    }
  }
  assert.ok(!open, "a run was left open");
}

/** The fake agent "fake" is registered on research and misc, and is research's room agent. */
async function withDispatch(script: FakeScript, fn: (ctx: DispatchCtx) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const fake = await startFakeAgui(script);
    const notifier = await createNotifier(db);
    const dispatchers: Dispatcher[] = [];
    try {
      const agent = await registerAgent(db, { name: "fake", url: fake.url, rooms: ["research", "misc"] });
      await setRoom(db, "research", { agent: "fake" });
      const lead = await agentAuth(db, "lead");
      const created: string[] = [];
      const logs: string[] = [];
      const events = async (id: string) => {
        const all: BoardEvent[] = [];
        for (let after: string | undefined; ; ) {
          const page = await listEvents(db, { threadId: id, after, limit: 1000 });
          all.push(...page.events);
          if (page.events.length < 1000) return all;
          after = page.cursor;
        }
      };
      await fn({
        db,
        fake,
        agent,
        logs,
        start: (extra = {}) => {
          const d = startDispatcher({ db, notifier, pollMs: 100, retryDelayMs: 50, log: (l) => logs.push(l), ...extra });
          dispatchers.push(d);
          return d;
        },
        create: async (room, labels) => {
          const t = await createTask(db, lead, { room, brief: `task ${created.length + 1}`, ...(labels ? { labels } : {}) });
          created.push(t.id);
          return t.id;
        },
        task: async (id) => (await loadTask(db, id))!,
        events,
        calls: (id) => fake.inputs.filter((i) => i.threadId === id).length,
      });
      await Promise.all(dispatchers.map((d) => d.stop()));
      for (const id of created) {
        const log = await events(id);
        assertAguiValid(log.flatMap((e) => e.agui));
        assertRunsBalanced(log);
      }
    } finally {
      await Promise.all(dispatchers.map((d) => d.stop()));
      await notifier.close();
      await fake.stop();
    }
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

const done = (i: Parameters<FakeScript>[0]) => [steps.started(i), ...steps.text("m1", "done"), steps.success(i)];
const settles = new Set(["task.released", "task.failed", "task.completed", "task.blocked"]);
const kinds = (log: BoardEvent[], kind: string) => log.filter((e) => e.kind === kind);

test("a ready task in a room with an agent is claimed and run on a notifier wake-up, with no manual claim", async () => {
  await withDispatch(done, async ({ agent, start, create, task, events, calls }) => {
    // No poll during the test: only the notifier can wake the dispatcher.
    const d = start({ pollMs: 60_000 });
    const id = await create("research");
    await until(async () => (await task(id)).state === "completed");
    await d.idle();
    const t = await task(id);
    assert.equal(t.result, "done");
    assert.equal(calls(id), 1);
    const [claimed] = kinds(await events(id), "task.claimed");
    assert.equal(claimed!.actor?.id, agent.actor.id);
    assert.deepEqual(claimed!.agui.map((a) => a.type), ["CUSTOM"]);
  });
});

test("a task labelled agent=fake in a room with no agent is dispatched; an unlabelled one is not", async () => {
  await withDispatch(done, async ({ start, create, task, calls }) => {
    const labelled = await create("misc", { agent: "fake" });
    const plain = await create("misc");
    await start().idle();
    assert.equal((await task(labelled)).state, "completed");
    assert.equal((await task(plain)).state, "ready");
    assert.equal(calls(plain), 0);
  });
});

test("an interrupt blocks; once a person answers, the dispatcher resumes the agent with the answer", async () => {
  await withDispatch(
    (i, call) =>
      call === 0
        ? [
            steps.started(i),
            steps.interrupt(i, { id: "int1", reason: "awaiting_approval", message: "ship it?", options: ["approve", "reject"] }),
          ]
        : [steps.started(i), ...steps.text("m2", "shipped"), steps.success(i)],
    async ({ db, fake, start, create, task }) => {
      const id = await create("research");
      const d = start();
      await d.idle();
      assert.equal((await task(id)).state, "blocked");
      assert.equal(fake.calls(), 1);

      await setRoom(db, "research", { approvers: ["ada"] });
      await answer(db, await personAuth(db, "ada"), id, { choice: "approve" });
      await until(async () => (await task(id)).state === "completed");
      await d.idle();
      assert.equal(fake.calls(), 2);
      assert.equal(fake.inputs[1]!.resume?.[0]?.interruptId, "int1");
      assert.deepEqual(fake.inputs[1]!.resume?.[0]?.payload, { choice: "approve" });
      const t = await task(id);
      assert.equal(t.result, "shipped");
      assert.equal(t.pendingResume, null);
    },
  );
});

test("two dispatchers on one database never run a task twice", async () => {
  await withDispatch(
    (i) => [steps.started(i), { delayMs: 100 }, ...steps.text("m1", "done"), steps.success(i)],
    async ({ start, create, task, calls }) => {
      const ids: string[] = [];
      for (let k = 0; k < 5; k++) ids.push(await create("research"));
      const a = start({ concurrency: 2 });
      const b = start({ concurrency: 2 });
      await Promise.all([a.idle(), b.idle()]);
      for (const id of ids) {
        assert.equal(calls(id), 1, `${id} ran ${calls(id)} times`);
        assert.equal((await task(id)).state, "completed");
      }
    },
  );
});

test("a dispatcher never runs more claims at once than its concurrency", async () => {
  await withDispatch(
    (i) => [steps.started(i), { delayMs: 50 }, steps.success(i, "ok")],
    async ({ db, start, create, task }) => {
      const ids: string[] = [];
      for (let k = 0; k < 4; k++) ids.push(await create("research"));
      await start({ concurrency: 1 }).idle();
      for (const id of ids) assert.equal((await task(id)).state, "completed");
      // In log order, each claim settles before the next one is taken.
      const log = (await listEvents(db, { kinds: ["task.claimed", "task.completed"], limit: 1000 })).events;
      assert.deepEqual(
        log.map((e) => e.kind),
        ids.flatMap(() => ["task.claimed", "task.completed"]),
      );
    },
  );
});

test("stop() aborts an in-flight run and the task is ready again within a second", async () => {
  await withDispatch(
    (i) => [steps.started(i), { delayMs: 5000 }, ...steps.text("m1", "late"), steps.success(i)],
    async ({ start, create, task, events }) => {
      const id = await create("research");
      const d = start();
      await until(async () => (await events(id)).some((e) => e.kind === "run.event" && e.agui[0]?.type === "RUN_STARTED"));
      const t0 = Date.now();
      await d.stop();
      assert.ok(Date.now() - t0 < 1000, `stop took ${Date.now() - t0} ms`);
      const t = await task(id);
      assert.equal(t.state, "ready");
      assert.equal(t.attempts, 0);
      // The agent's run was open, so the release closes it.
      assert.deepEqual(kinds(await events(id), "task.released").at(-1)!.agui.map((a) => a.type), ["RUN_ERROR"]);
    },
  );
});

test("stop() between board-tool rounds releases without a RUN_ERROR: the agent had already ended its run", async () => {
  await withDispatch(
    (i, call) =>
      call === 0
        ? [steps.started(i), ...steps.toolCall("tc1", "teamkit_reply", { threadId: i.threadId, text: "on it" }), steps.success(i)]
        : [{ delayMs: 5000 }, steps.started(i), steps.success(i)],
    async ({ fake, start, create, task, events }) => {
      const id = await create("research");
      const d = start();
      // The second round's request is out; the first round's RUN_FINISHED is the log's last word.
      await until(() => fake.calls() === 2);
      await d.stop();
      const t = await task(id);
      assert.equal(t.state, "ready");
      assert.equal(t.attempts, 0);
      const log = await events(id);
      assert.deepEqual(
        kinds(log, "task.released").at(-1)!.agui.map((a) => [a.type, a.name]),
        [["CUSTOM", "teamkit.task.released"]],
      );
      assert.equal(log.flatMap((e) => e.agui).some((a) => a.type === "RUN_ERROR"), false);
    },
  );
});

test("a stream that drops on every call is retried with backoff, then fails after exactly 3 runs", async () => {
  await withDispatch(
    (i) => [steps.started(i), { drop: true }],
    async ({ start, create, task, events, calls }) => {
      const id = await create("research");
      await start().idle();
      const t = await task(id);
      assert.equal(t.state, "failed");
      assert.equal(calls(id), 3);
      const log = await events(id);
      assert.equal(kinds(log, "task.released").length, 2);
      assert.match(String(kinds(log, "task.failed")[0]!.data.reason), /^agent run failed 3 times/);
    },
  );
});

test("a task waiting out its retry delay keeps idle() waiting until the retry has run", async () => {
  await withDispatch(
    (i, call) => (call === 0 ? [steps.started(i), { drop: true }] : done(i)),
    async ({ fake, logs, start, create, task }) => {
      const id = await create("research");
      let waited: Promise<number> | undefined;
      const d = start({
        retryDelayMs: 500,
        log: (line) => {
          logs.push(line);
          // runClaim logs the release just before the dispatcher sees it: idle() right after the first drop.
          if (!waited && / released /.test(line)) {
            const t0 = Date.now();
            waited = d.idle().then(() => Date.now() - t0);
          }
        },
      });
      await until(() => waited !== undefined);
      const elapsed = await waited!;
      assert.ok(elapsed >= 500, `idle() resolved after ${elapsed} ms`);
      assert.equal(fake.calls(), 2);
      const t = await task(id);
      assert.equal(t.state, "completed");
      assert.equal(t.attempts, 1);
    },
  );
});

test("a stream that drops before a later round starts is released without a RUN_ERROR, then retried", async () => {
  await withDispatch(
    (i, call) => {
      if (call === 0) {
        return [steps.started(i), ...steps.toolCall("tc1", "teamkit_reply", { threadId: i.threadId, text: "on it" }), steps.success(i)];
      }
      return call === 1 ? [{ drop: true }] : done(i);
    },
    async ({ start, create, task, events, calls }) => {
      const id = await create("research");
      await start().idle();
      const t = await task(id);
      assert.equal(t.state, "completed");
      assert.equal(t.attempts, 1);
      assert.equal(calls(id), 3);
      const log = await events(id);
      assert.deepEqual(
        kinds(log, "task.released").map((e) => e.agui.map((a) => [a.type, a.name])),
        [[["CUSTOM", "teamkit.task.released"]]],
      );
      assert.equal(log.flatMap((e) => e.agui).some((a) => a.type === "RUN_ERROR"), false);
    },
  );
});

test("a task its agent may not claim is logged once and left alone without keeping idle() waiting", async () => {
  await withDispatch(done, async ({ logs, start, create, task, events, calls }) => {
    // The fake holds no grant in "elsewhere", so the label routes the task to an agent that cannot claim it.
    const id = await create("elsewhere", { agent: "fake" });
    const d = start();
    await d.idle();
    await d.idle();
    assert.equal((await task(id)).state, "ready");
    assert.equal(calls(id), 0);
    const refusals = logs.filter((l) => l.includes(id));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!, /not dispatched: .*lacks claim in elsewhere/);
    assert.deepEqual((await events(id)).filter((e) => settles.has(e.kind) || e.kind === "task.claimed"), []);
  });
});

test("a 1000-event agent stream starts at most one scan per wakeEveryMs, not one per event", async () => {
  await withDispatch(
    (i) => [
      steps.started(i),
      { event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      ...Array.from({ length: 1000 }, () => ({ event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "tok " } })),
      { event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      steps.success(i),
    ],
    async ({ db, start, create, task }) => {
      let scans = 0;
      // listDispatchable is the dispatcher's only query that routes a task to its agent.
      const counting = new Proxy(db, {
        apply(target, self, args) {
          if (Array.isArray(args[0]) && args[0].join("").includes("select t.thread_id as task_id, a.*")) scans++;
          return Reflect.apply(target, self, args);
        },
      });
      const d = start({ db: counting, pollMs: 60_000 });
      await d.idle();
      const before = scans;
      const t0 = Date.now();
      const id = await create("research");
      await until(async () => (await task(id)).state === "completed", 30_000);
      await d.idle();
      const elapsed = Date.now() - t0;
      const during = scans - before;
      assert.ok(during >= 1);
      assert.ok(during <= Math.ceil(elapsed / 250) + 3, `${during} scans in ${elapsed} ms`);
    },
  );
});

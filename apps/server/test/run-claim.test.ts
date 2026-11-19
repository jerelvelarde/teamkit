import { test } from "node:test";
import assert from "node:assert/strict";
import { isBoardError, type AguiEvent, type BoardEvent, type Claim, type Task } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { agentAuthContext, registerAgent, type RegisteredAgent } from "../src/dispatch/registry.js";
import { runClaim, type DispatchResult, type RunClaimOptions } from "../src/dispatch/run-claim.js";
import type { AuthContext } from "../src/store/actors.js";
import { answer } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { reapExpired } from "../src/store/reaper.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { getThread } from "../src/store/threads.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { withTestDb } from "./helpers/db.js";
import { startFakeAgui, steps, type FakeScript } from "./helpers/fake-agui.js";

type Fake = Awaited<ReturnType<typeof startFakeAgui>>;

/** A registered agent pointing at a scripted fake, and a ready task in its room created by another agent's token. */
interface ClaimCtx {
  db: Db;
  fake: Fake;
  agent: RegisteredAgent;
  lead: AuthContext;
  taskId: string;
  /** Claims the task by hand for the agent, without opening a run. */
  claim(): Promise<Claim>;
  run(claim: Claim, extra?: Partial<RunClaimOptions>): Promise<DispatchResult>;
  task(): Promise<Task>;
  events(): Promise<BoardEvent[]>;
  logs: string[];
}

async function withClaim(script: FakeScript, fn: (ctx: ClaimCtx) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const fake = await startFakeAgui(script);
    try {
      const agent = await registerAgent(db, { name: "fake", url: fake.url, rooms: ["research"] });
      const lead = await agentAuth(db, "lead");
      const { id: taskId } = await createTask(db, lead, { room: "research", brief: "look into it" });
      const logs: string[] = [];
      const events = async () => (await listEvents(db, { threadId: taskId })).events;
      await fn({
        db,
        fake,
        agent,
        lead,
        taskId,
        claim: () => claimTask(db, agentAuthContext(agent), taskId, { opensRun: false }),
        run: (claim, extra = {}) => runClaim({ db, log: (l) => logs.push(l), ...extra }, agent, claim),
        task: async () => (await loadTask(db, taskId))!,
        events,
        logs,
      });
      assertAguiValid((await events()).flatMap((e) => e.agui));
    } finally {
      await fake.stop();
    }
  });
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const first = (e: BoardEvent) => e.agui[0] as AguiEvent;
const settled = (events: BoardEvent[], kind: string) => events.filter((e) => e.kind === kind);

test("a successful run completes the task; the claim opens no run and the agent's events sit between", async () => {
  await withClaim(
    (i) => [steps.started(i), ...steps.text("m1", "done"), steps.success(i)],
    async ({ fake, taskId, claim, run, task, events, logs }) => {
      assert.equal(await run(await claim()), "completed");
      const t = await task();
      assert.equal(t.state, "completed");
      assert.equal(t.result, "done");
      assert.deepEqual(fake.inputs[0]!.context, [
        {
          description: "TeamKit task",
          value: JSON.stringify({ taskId, room: "research", labels: {}, brief: "look into it" }),
        },
      ]);

      const all = await events();
      for (let k = 1; k < all.length; k++) assert.ok(BigInt(all[k]!.cursor) > BigInt(all[k - 1]!.cursor));
      const kinds = all.map((e) => e.kind);
      const claimed = kinds.indexOf("task.claimed");
      const completed = kinds.indexOf("task.completed");
      assert.deepEqual(all[claimed]!.agui.map((a) => a.type), ["CUSTOM"]);
      assert.deepEqual(
        all.slice(claimed + 1, completed).map((e) => `${e.kind}:${first(e).type}`),
        ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"].map(
          (t) => `run.event:${t}`,
        ),
      );
      assert.equal(completed, kinds.length - 1);
      assert.deepEqual(
        all[completed]!.agui.map((a) => [a.type, a.name]),
        [["CUSTOM", "teamkit.task.completed"]],
      );
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /^fake \S+: completed/);
    },
  );
});

test("an approval interrupt blocks; only a listed person answers; the resumed run gets the answer and completes", async () => {
  await withClaim(
    (i, call) =>
      call === 0
        ? [
            steps.started(i),
            steps.interrupt(i, { id: "int1", reason: "awaiting_approval", message: "ship it?", options: ["approve", "reject"] }),
          ]
        : [steps.started(i), ...steps.text("m2", "shipped"), steps.success(i)],
    async ({ db, fake, agent, lead, taskId, claim, run, task, events }) => {
      assert.equal(await run(await claim()), "blocked");
      const blocked = await task();
      assert.equal(blocked.state, "blocked");
      const { blockedBy, ...blk } = blocked.block!;
      assert.deepEqual(blk, { interruptId: "int1", kind: "awaiting_approval", question: "ship it?", options: ["approve", "reject"] });
      assert.equal(blockedBy.id, agent.actor.id);
      const [ev] = settled(await events(), "task.blocked");
      assert.equal(ev!.agui.some((a) => a.type === "RUN_FINISHED"), false);
      assert.ok(ev!.agui.some((a) => a.type === "CUSTOM" && a.name === "teamkit.task.blocked"));

      await assert.rejects(
        answer(db, lead, taskId, { choice: "approve" }),
        (e) => isBoardError(e) && e.code === "approval_requires_person",
      );
      await setRoom(db, "research", { approvers: ["ada"] });
      await answer(db, await personAuth(db, "ada"), taskId, { choice: "approve" });

      assert.equal(await run(await claim()), "completed");
      assert.equal(fake.calls(), 2);
      assert.deepEqual(fake.inputs[1]!.resume?.[0], {
        interruptId: "int1",
        status: "resolved",
        payload: { choice: "approve" },
      });
      const done = await task();
      assert.equal(done.state, "completed");
      assert.equal(done.result, "shipped");
      assert.equal(done.pendingResume, null);
    },
  );
});

test("a resume is cleared once delivered, even when that run fails; an undelivered one is sent again", async () => {
  await withClaim(
    (i, call) => {
      switch (call) {
        case 0:
          return [steps.started(i), steps.interrupt(i, { id: "int1", reason: "input", message: "which one?" })];
        case 1:
          return [steps.started(i), { drop: true }];
        case 2:
          return [steps.started(i), steps.runError("busy", "E_BUSY")];
        default:
          return [steps.started(i), steps.success(i, "blue it is")];
      }
    },
    async ({ db, fake, lead, taskId, claim, run, task, events }) => {
      assert.equal(await run(await claim()), "blocked");
      assert.equal((await task()).block?.kind, "needs_input");
      await answer(db, lead, taskId, { text: "the blue one" });
      const resume = [{ interruptId: "int1", status: "resolved", payload: { text: "the blue one" } }];

      // A dropped stream never delivered the resume: it stays, and the run is closed by TeamKit.
      assert.equal(await run(await claim()), "released");
      assert.deepEqual(fake.inputs[1]!.resume, resume);
      let t = await task();
      assert.deepEqual(t.pendingResume, resume);
      assert.equal(t.attempts, 1);
      let released = settled(await events(), "task.released");
      assert.deepEqual(released.at(-1)!.agui.map((a) => a.type), ["RUN_ERROR"]);

      // The agent's own RUN_ERROR means it got the resume: cleared, and the agent closed its run.
      assert.equal(await run(await claim()), "released");
      assert.deepEqual(fake.inputs[2]!.resume, resume);
      t = await task();
      assert.equal(t.pendingResume, null);
      assert.equal(t.attempts, 2);
      released = settled(await events(), "task.released");
      assert.deepEqual(
        released.at(-1)!.agui.map((a) => [a.type, a.name]),
        [["CUSTOM", "teamkit.task.released"]],
      );

      assert.equal(await run(await claim()), "completed");
      assert.equal(fake.inputs[3]!.resume, undefined);
      assert.equal((await task()).result, "blue it is");
    },
  );
});

test("a stream that drops every time is released twice, then fails on the third attempt", async () => {
  await withClaim(
    (i) => [steps.started(i), { drop: true }],
    async ({ claim, run, task, events, logs }) => {
      assert.equal(await run(await claim()), "released");
      assert.equal((await task()).attempts, 1);
      assert.equal(await run(await claim()), "released");
      assert.equal((await task()).attempts, 2);
      assert.equal(await run(await claim()), "failed");
      assert.equal((await task()).state, "failed");
      const [failed] = settled(await events(), "task.failed");
      assert.match(String(failed!.data.reason), /^agent run failed 3 times/);
      assert.deepEqual(failed!.agui.map((a) => a.type), ["RUN_ERROR"]);
      assert.equal(logs.length, 3);
    },
  );
});

test("renewing keeps a short lease alive through a long run", async () => {
  await withEnv({ TEAMKIT_LEASE_MS: "1000" }, async () => {
    await withClaim(
      (i) => [steps.started(i), { delayMs: 2500 }, ...steps.text("m1", "slow"), steps.success(i)],
      async ({ db, claim, run, task }) => {
        const c = await claim();
        const [result, reaped] = await Promise.all([
          run(c, { renewEveryMs: 200 }),
          sleep(1500).then(() => reapExpired(db)),
        ]);
        assert.equal(reaped, 0);
        assert.equal(result, "completed");
        assert.equal((await task()).result, "slow");
      },
    );
  });
});

test("aborting the signal stops the run and releases the task without counting an attempt", async () => {
  await withClaim(
    (i) => [steps.started(i), { delayMs: 5000 }, ...steps.text("m1", "late"), steps.success(i)],
    async ({ claim, run, task, events }) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const t0 = Date.now();
      assert.equal(await run(await claim(), { signal: ac.signal }), "aborted");
      assert.ok(Date.now() - t0 < 2000);
      const t = await task();
      assert.equal(t.state, "ready");
      assert.equal(t.attempts, 0);
      assert.deepEqual(settled(await events(), "task.released").at(-1)!.agui.map((a) => a.type), ["RUN_ERROR"]);
    },
  );
});

test("a claim lost mid-run stops the run and settles nothing", async () => {
  await withClaim(
    (i) => [steps.started(i), { delayMs: 3000 }, ...steps.text("m1", "late"), steps.success(i)],
    async ({ db, taskId, claim, run, task, events, logs }) => {
      const other = await agentAuth(db, "other");
      const takeOver = async () => {
        await sleep(300);
        // What the reaper does to a lapsed lease, in one statement so a renew cannot slip in between.
        await db`
          update tasks set state = 'ready', claim_id = null, claimed_by = null, lease_expires_at = null
          where thread_id = ${taskId}`;
        await claimTask(db, other, taskId, { opensRun: false });
      };
      const t0 = Date.now();
      const [result] = await Promise.all([run(await claim(), { renewEveryMs: 200 }), takeOver()]);
      assert.equal(result, "lost");
      assert.ok(Date.now() - t0 < 2000);
      const t = await task();
      assert.equal(t.state, "claimed");
      assert.equal(t.claim?.actor.id, other.actor.id);
      const settles = new Set(["task.completed", "task.released", "task.failed", "task.blocked"]);
      assert.deepEqual((await events()).filter((e) => settles.has(e.kind)), []);
      assert.match(logs.at(-1)!, /: lost/);
    },
  );
});

test("an agent that streams NUL and lone surrogates completes; the log, thread and result hold U+FFFD", async () => {
  const dirty = "a\u0000b\uD800c\uDC00d 😀";
  const clean = "a�b�c�d 😀";
  await withClaim(
    (i) => [
      steps.started(i),
      { event: { type: "CUSTOM", name: "note\u0000", value: { "k\u0000ey": ["x\uD800"] } } },
      ...steps.text("m1", dirty),
      steps.success(i, `result ${dirty}`),
    ],
    async ({ db, agent, taskId, claim, run, task, events }) => {
      assert.equal(await run(await claim()), "completed");
      assert.equal((await task()).result, `result ${clean}`);

      const logged = (await events()).filter((e) => e.kind === "run.event").map(first);
      assert.deepEqual(logged.find((e) => e.type === "CUSTOM"), {
        type: "CUSTOM",
        name: "note�",
        value: { "k�ey": ["x�"] },
      });
      assert.equal(logged.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta, clean);
      const messages = (await getThread(db, agentAuthContext(agent), taskId)).messages;
      assert.equal(messages.at(-1)?.content, clean);
    },
  );
});

test("an interrupt with NUL in its id and message blocks with the scrubbed text", async () => {
  await withClaim(
    (i) => [steps.started(i), steps.interrupt(i, { id: "int\u00001", reason: "input", message: "ok\u0000?" })],
    async ({ claim, run, task }) => {
      assert.equal(await run(await claim()), "blocked");
      const b = (await task()).block!;
      assert.equal(b.interruptId, "int�1");
      assert.equal(b.question, "ok�?");
    },
  );
});

test("a pending call to a tool the board lacks fails the task", async () => {
  await withClaim(
    (i) => [steps.started(i), ...steps.toolCall("tc1", "weather", { city: "x" }), steps.success(i)],
    async ({ claim, run, task, events }) => {
      assert.equal(await run(await claim()), "failed");
      assert.equal((await task()).state, "failed");
      const [failed] = settled(await events(), "task.failed");
      assert.equal(failed!.data.reason, "agent called a tool the board does not provide: weather");
      assert.deepEqual(failed!.agui.map((a) => [a.type, a.name]), [["CUSTOM", "teamkit.task.failed"]]);
    },
  );
});

test("an interrupt whose options the board refuses fails the task instead of looping", async () => {
  await withClaim(
    (i) => [steps.started(i), steps.interrupt(i, { id: "int1", reason: "input", message: "pick", options: ["a", "a"] })],
    async ({ claim, run, task, events }) => {
      assert.equal(await run(await claim()), "failed");
      assert.equal((await task()).state, "failed");
      const [failed] = settled(await events(), "task.failed");
      assert.match(String(failed!.data.reason), /^the agent's interrupt could not be stored: options must be unique/);
    },
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { getAgent, registerAgent } from "../src/dispatch/registry.js";
import { createNotifier, type Notifier } from "../src/notifier.js";
import type { AuthContext } from "../src/store/actors.js";
import { block } from "../src/store/blocks.js";
import { claimTask, complete } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { findLeadThread } from "../src/triggers/lead.js";
import { runTriggerOnce, startTriggers, type TriggerRunnerOptions } from "../src/triggers/runner.js";
import {
  addTrigger,
  listStoredTriggers,
  listTriggers,
  removeTrigger,
  setTriggerEnabled,
} from "../src/triggers/store.js";
import { verifySignature } from "../src/triggers/webhook.js";
import { agentAuth } from "./helpers/actors.js";
import { withTestDb } from "./helpers/db.js";
import { startFakeAgui, steps, type FakeScript } from "./helpers/fake-agui.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Hit {
  cursor: string;
  threadId: string | null;
  raw: string;
  eventHeader: string | undefined;
  triggerHeader: string | undefined;
  signature: string | undefined;
  status: number;
}

/** A webhook receiver over real sockets. `fail(event)` true → 500; `hang` → never answers. */
async function receiver(opts: { hang?: boolean } = {}) {
  const hits: Hit[] = [];
  let fail: (e: BoardEvent) => boolean = () => false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (opts.hang) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      const event = (JSON.parse(raw) as { event: BoardEvent }).event;
      const status = fail(event) ? 500 : 200;
      hits.push({
        cursor: event.cursor,
        threadId: event.threadId,
        raw,
        eventHeader: req.headers["x-teamkit-event"] as string | undefined,
        triggerHeader: req.headers["x-teamkit-trigger"] as string | undefined,
        signature: req.headers["x-teamkit-signature"] as string | undefined,
        status,
      });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    hits,
    ok: () => hits.filter((h) => h.status === 200),
    setFail(f: (e: BoardEvent) => boolean) {
      fail = f;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Creates and completes a task; returns its id and the task.completed cursor. */
async function completeTask(db: Db, auth: AuthContext, room: string, labels?: Record<string, string>) {
  const t = await createTask(db, auth, { room, brief: `work in ${room}`, labels });
  const c = await claimTask(db, auth, t.id);
  await complete(db, auth, t.id, c.claimId, "done");
  const [e] = (await listEvents(db, { threadId: t.id, kinds: ["task.completed"] })).events;
  return { id: t.id, cursor: e!.cursor };
}

async function cursorOf(db: Db, name: string): Promise<string> {
  const t = (await listTriggers(db)).find((x) => x.name === name);
  assert.ok(t, `trigger ${name} exists`);
  return t.cursor;
}

function options(db: Db, notifier: Notifier, logs: string[], extra: Partial<TriggerRunnerOptions> = {}) {
  return {
    db,
    notifier,
    retryDelayMs: 50,
    webhook: { backoffMs: [10, 10] },
    log: (l: string) => logs.push(l),
    ...extra,
  } satisfies TriggerRunnerOptions;
}

const isSorted = (cs: string[]) => cs.every((c, i) => i === 0 || BigInt(cs[i - 1]!) <= BigInt(c));

test("a webhook trigger posts each matching event once, in cursor order, signed with its secret", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      const { secret } = await addTrigger(db, { name: "hook", room: "build/", kinds: ["task.completed"], webhook: rx.url });
      assert.ok(secret);
      const notifier = await createNotifier(db);
      const logs: string[] = [];
      // A long poll: deliveries here come from notifier wake-ups.
      const runner = startTriggers(options(db, notifier, logs, { pollMs: 60_000 }));
      try {
        const done = [];
        for (const room of ["build", "other", "build", "build"]) done.push({ room, ...(await completeTask(db, bot, room)) });
        const want = done.filter((d) => d.room === "build").map((d) => d.cursor);
        await waitFor("3 deliveries", () => rx.hits.length >= 3);
        await runner.idle();

        assert.deepEqual(rx.hits.map((h) => h.cursor), want);
        for (const h of rx.hits) {
          assert.equal(h.status, 200);
          assert.ok(verifySignature(secret, h.raw, h.signature), "signature verifies over the raw body");
          assert.equal(h.eventHeader, h.cursor);
          assert.equal(h.triggerHeader, "hook");
        }
        assert.equal(await cursorOf(db, "hook"), want[2]);
        assert.equal(logs.some((l) => l.includes(secret)), false);
      } finally {
        await runner.stop();
        await notifier.close();
      }
    });
  } finally {
    await rx.close();
  }
});

test("runTriggerOnce pages in order and stops ON the failed event", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      await addTrigger(db, { name: "hook", room: "build", kinds: ["task.completed"], webhook: rx.url });
      const one = await completeTask(db, bot, "build");
      const two = await completeTask(db, bot, "build");
      const three = await completeTask(db, bot, "build");
      rx.setFail((e) => e.cursor === two.cursor);
      const logs: string[] = [];
      const idle: Notifier = { onEvent: () => () => {}, close: async () => {} };
      const o = options(db, idle, logs, { batch: 1 });

      const [t] = await listStoredTriggers(db);
      assert.deepEqual(await runTriggerOnce(o, t!), { delivered: 1, stalled: true });
      assert.equal(t!.cursor, one.cursor);
      assert.equal(await cursorOf(db, "hook"), one.cursor);
      assert.equal(rx.hits.filter((h) => h.cursor === two.cursor).length, 3, "three attempts on the failed event");

      rx.setFail(() => false);
      assert.deepEqual(await runTriggerOnce(o, t!), { delivered: 2, stalled: false });
      assert.deepEqual(rx.ok().map((h) => h.cursor), [one.cursor, two.cursor, three.cursor]);
      assert.equal(await cursorOf(db, "hook"), three.cursor);
      assert.ok(logs.some((l) => l.includes(`event ${two.cursor}`)));
    });
  } finally {
    await rx.close();
  }
});

test("a failing receiver holds the trigger on that event; retries then deliver the rest in order", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      const { secret } = await addTrigger(db, { name: "hook", room: "build/", kinds: ["task.completed"], webhook: rx.url });
      const one = await completeTask(db, bot, "build");
      const two = await completeTask(db, bot, "build");
      const three = await completeTask(db, bot, "build");
      rx.setFail((e) => e.cursor === two.cursor);
      const notifier = await createNotifier(db);
      const logs: string[] = [];
      const runner = startTriggers(options(db, notifier, logs));
      try {
        // Two passes of three attempts each: the stalled worker retried on its own.
        await waitFor("a retried pass", () => rx.hits.filter((h) => h.cursor === two.cursor).length >= 6);
        assert.equal(rx.hits.some((h) => h.cursor === three.cursor), false, "nothing after the failed event");
        assert.equal(await cursorOf(db, "hook"), one.cursor);

        rx.setFail(() => false);
        await waitFor("event #3", () => rx.ok().some((h) => h.cursor === three.cursor));
        await runner.idle();
        assert.deepEqual(rx.ok().map((h) => h.cursor), [one.cursor, two.cursor, three.cursor]);
        assert.ok(isSorted(rx.hits.map((h) => h.cursor)), "every request, failed or not, in cursor order");
        assert.equal(await cursorOf(db, "hook"), three.cursor);
        assert.ok(logs.some((l) => l.includes("will retry")));
        assert.equal(logs.some((l) => l.includes(secret!)), false);
      } finally {
        await runner.stop();
        await notifier.close();
      }
    });
  } finally {
    await rx.close();
  }
});

test("across a restart every event is delivered at least once, in order, with no gap", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      await addTrigger(db, { name: "hook", room: "build/", kinds: ["task.completed"], webhook: rx.url });
      const one = await completeTask(db, bot, "build");
      const two = await completeTask(db, bot, "build");
      const three = await completeTask(db, bot, "build");
      const notifier = await createNotifier(db);
      try {
        rx.setFail((e) => e.cursor === two.cursor);
        const a = startTriggers(options(db, notifier, []));
        await a.idle();
        await a.stop();
        assert.equal(await cursorOf(db, "hook"), one.cursor);
        const seen = rx.hits.length;
        await sleep(150);
        assert.equal(rx.hits.length, seen, "a stopped runner makes no further attempts");

        rx.setFail(() => false);
        const b = startTriggers(options(db, notifier, []));
        try {
          await b.idle();
        } finally {
          await b.stop();
        }
        const ok = rx.ok().map((h) => h.cursor);
        assert.ok(isSorted(ok), "deliveries in cursor order");
        assert.deepEqual([...new Set(ok)], [one.cursor, two.cursor, three.cursor]);
        assert.equal(await cursorOf(db, "hook"), three.cursor);
      } finally {
        await notifier.close();
      }
    });
  } finally {
    await rx.close();
  }
});

test("a labels filter delivers only matching tasks; skipped events still move the cursor", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      await addTrigger(db, {
        name: "workers",
        room: "build",
        kinds: ["task.completed"],
        labels: { role: "worker" },
        webhook: rx.url,
      });
      const a = await completeTask(db, bot, "build", { role: "worker" });
      await completeTask(db, bot, "build", { role: "lead" });
      const c = await completeTask(db, bot, "build", { role: "worker", team: "x" });
      const d = await completeTask(db, bot, "build");
      const notifier = await createNotifier(db);
      const runner = startTriggers(options(db, notifier, []));
      try {
        await runner.idle();
        assert.deepEqual(rx.hits.map((h) => h.threadId), [a.id, c.id]);
        assert.equal(await cursorOf(db, "workers"), d.cursor);
      } finally {
        await runner.stop();
        await notifier.close();
      }
    });
  } finally {
    await rx.close();
  }
});

test("an agent trigger wakes the lead, which answers the blocked task through a board tool", async () => {
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
    const notifier = await createNotifier(db);
    const runner = startTriggers(options(db, notifier, []));
    try {
      await registerAgent(db, { name: "lead", url: fake.url, rooms: ["build"] });
      await addTrigger(db, { name: "lead-wake", room: "build", kinds: ["task.blocked"], agent: "lead" });
      const worker = await agentAuth(db, "worker");
      ({ id: taskId } = await createTask(db, worker, { room: "build", brief: "Pick a database" }));
      const claim = await claimTask(db, worker, taskId);
      await block(db, worker, taskId, claim.claimId, {
        question: "Which database?",
        kind: "needs_input",
        options: ["pg", "sqlite"],
      });

      await waitFor("the lead's answer", async () => (await loadTask(db, taskId))?.state === "ready", 5000);
      const task = (await loadTask(db, taskId))!;
      assert.equal(task.pendingResume?.[0]?.payload?.choice, "pg");
      const lead = (await getAgent(db, "lead"))!;
      const leadThread = await findLeadThread(db, lead, "build");
      assert.ok(leadThread, "the lead thread exists");
      assert.equal(fake.inputs[0]!.threadId, leadThread);
      await runner.idle();
      assert.equal(fake.calls(), 3, "one wake-up: read, answer, reply");
    } finally {
      await runner.stop();
      await notifier.close();
      await fake.stop();
    }
  });
});

test("a stalled trigger never holds up another trigger", async () => {
  const stuck = await receiver({ hang: true });
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      await addTrigger(db, { name: "a-stuck", room: "build", kinds: ["task.completed"], webhook: stuck.url });
      await addTrigger(db, { name: "b-fine", room: "build", kinds: ["task.completed"], webhook: rx.url });
      const stuckStart = await cursorOf(db, "a-stuck");
      const notifier = await createNotifier(db);
      const runner = startTriggers(options(db, notifier, [], { webhook: { backoffMs: [10, 10], timeoutMs: 10_000 } }));
      try {
        const done = [];
        for (let i = 0; i < 3; i++) done.push(await completeTask(db, bot, "build"));
        // The stuck receiver holds its first request for up to 10 s; the other trigger goes on.
        await waitFor("the healthy trigger", () => rx.hits.length === 3, 3000);
        assert.deepEqual(rx.hits.map((h) => h.cursor), done.map((d) => d.cursor));
        assert.equal(await cursorOf(db, "a-stuck"), stuckStart);
      } finally {
        await stuck.close();
        await runner.stop();
        await notifier.close();
      }
    });
  } finally {
    await stuck.close();
    await rx.close();
  }
});

test("a disabled trigger is skipped and keeps its place; a removed one gets nothing more", async () => {
  const rx = await receiver();
  try {
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      await addTrigger(db, { name: "hook", room: "build", kinds: ["task.completed"], webhook: rx.url });
      const notifier = await createNotifier(db);
      const runner = startTriggers(options(db, notifier, []));
      try {
        await setTriggerEnabled(db, "hook", false);
        const held = await completeTask(db, bot, "build");
        await runner.idle();
        await sleep(100);
        await runner.idle();
        assert.equal(rx.hits.length, 0, "disabled: nothing delivered");

        await setTriggerEnabled(db, "hook", true);
        await runner.idle();
        assert.deepEqual(rx.hits.map((h) => h.cursor), [held.cursor], "re-enabled: picks up where it stopped");

        await removeTrigger(db, "hook");
        await completeTask(db, bot, "build");
        await runner.idle();
        await sleep(100);
        await runner.idle();
        assert.equal(rx.hits.length, 1, "removed: nothing more");
      } finally {
        await runner.stop();
        await notifier.close();
      }
    });
  } finally {
    await rx.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { countingNotifier, liveCount, serveApp, type CountingNotifier } from "./helpers/notifier.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import type { AuthContext } from "../src/store/actors.js";
import type { Db } from "../src/db/pool.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withApp(
  fn: (ctx: {
    app: ReturnType<typeof createApp>;
    db: Db;
    bot: AuthContext & { token: string };
    notifier: CountingNotifier;
    poll: (body: unknown, signal?: AbortSignal) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = countingNotifier(await createNotifier(db));
    try {
      const bot = await agentAuth(db, "bot");
      const app = createApp({ db, notifier });
      const poll = (body: unknown, signal?: AbortSignal) =>
        Promise.resolve(
          app.request("/v1/tasks/claim-next", {
            method: "POST",
            headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          }),
        );
      await fn({ app, db, bot, notifier, poll });
    } finally {
      await notifier.close();
    }
  });
}

test("waitMs 3000 with nothing ready is 204 after about 3 s", async () => {
  await withApp(async ({ poll }) => {
    const t0 = Date.now();
    const res = await poll({ room: "*", waitMs: 3000 });
    const dt = Date.now() - t0;
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.ok(dt >= 2500 && dt < 6000, `took ${dt} ms`);
  });
});

test("a task created mid-wait is claimed within 1 s", async () => {
  await withApp(async ({ db, bot, poll }) => {
    const pending = poll({ room: "*", waitMs: 10000 });
    await sleep(500);
    const task = await createTask(db, bot, { room: "build", brief: "late" });
    const created = Date.now();
    const res = await pending;
    const dt = Date.now() - created;
    assert.equal(res.status, 200);
    const claim = (await res.json()) as { task: { id: string } };
    assert.equal(claim.task.id, task.id);
    assert.ok(dt < 1000, `took ${dt} ms after create`);
  });
});

test("waitMs 0 claims a ready task at once and 204s when none", async () => {
  await withApp(async ({ db, bot, poll }) => {
    const t0 = Date.now();
    const none = await poll({ room: "*", waitMs: 0 });
    assert.equal(none.status, 204);
    assert.ok(Date.now() - t0 < 500);
    const task = await createTask(db, bot, { room: "build", brief: "now" });
    const res = await poll({ room: "*" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { task: { id: string } }).task.id, task.id);
  });
});

test("an aborted poll claims nothing and unsubscribes", async () => {
  await withApp(async ({ db, bot, notifier, poll }) => {
    const ac = new AbortController();
    const pending = poll({ room: "*", waitMs: 10000 }, ac.signal).catch((e: unknown) => e);
    assert.equal(await liveCount(notifier, 1), 1, "the waiting poll is subscribed");
    ac.abort();
    await pending;
    assert.equal(await liveCount(notifier, 0), 0);
    const task = await createTask(db, bot, { room: "build", brief: "after abort" });
    await sleep(300);
    const res = await poll({ room: "*" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { task: { id: string } }).task.id, task.id);
  });
});

test("destroying a waiting poll's socket unsubscribes", async () => {
  await withApp(async ({ app, bot, notifier }) => {
    const srv = await serveApp(app);
    try {
      const req = request(`${srv.url}/v1/tasks/claim-next`, {
        method: "POST",
        headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
      });
      req.on("error", () => {});
      req.end(JSON.stringify({ room: "*", waitMs: 10000 }));
      assert.equal(await liveCount(notifier, 1), 1, "the waiting poll is subscribed");
      req.destroy();
      assert.equal(await liveCount(notifier, 0), 0);
    } finally {
      await srv.close();
    }
  });
});

test("a poll aborted while claimNext runs releases the claim it took", async () => {
  await withApp(async ({ db, bot, notifier, poll }) => {
    const task = await createTask(db, bot, { room: "build", brief: "raced" });
    // Hold the event-log lock so claimNext stalls after taking the claim, before committing.
    let unlock!: () => void;
    const gate = new Promise<void>((r) => (unlock = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7731)`;
      locked();
      await gate;
    });
    await isLocked;
    const ac = new AbortController();
    const pending = poll({ room: "*", waitMs: 10000 }, ac.signal);
    try {
      for (let i = 0; ; i++) {
        const [w] = await db`
          select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())`;
        if (w!.n > 0) break;
        if (i > 200) throw new Error("claimNext never waited on the lock");
        await sleep(10);
      }
      ac.abort();
    } finally {
      unlock();
      await holder;
    }
    const res = await pending;
    assert.equal(res.status, 204);
    const after = await loadTask(db, task.id);
    assert.equal(after!.state, "ready");
    assert.equal(after!.claim, null);
    assert.equal(await liveCount(notifier, 0), 0);
  });
});

test("missing room and negative waitMs are 400 invalid_input", async () => {
  await withApp(async ({ poll }) => {
    for (const body of [{}, { room: "*", waitMs: -1 }, { room: "*", waitMs: "5" }]) {
      const res = await poll(body);
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_input");
    }
  });
});

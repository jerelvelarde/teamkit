import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createPlan, createTask } from "../src/store/tasks.js";
import { claimTask, complete } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";
import { createDb, type Db } from "../src/db/pool.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const count = async (db: Db) => (await db`select count(*)::int as n from tasks`)[0]!.n as number;

test("a task with no needs is ready; one with an incomplete need is waiting", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const a = await createTask(db, bot, { room: "build", brief: "do a" });
    assert.equal(a.state, "ready");
    assert.deepEqual(a.needs, []);
    const b = await createTask(db, bot, { room: "build", brief: "do b", needs: [a.id, a.id] });
    assert.equal(b.state, "waiting");
    assert.deepEqual(b.needs, [a.id]);
    assert.deepEqual(b.needStates, { [a.id]: "ready" });
    await db`update tasks set state = 'completed' where thread_id = ${a.id}`;
    const c = await createTask(db, bot, { room: "build", brief: "do c", needs: [a.id], target: "x" });
    assert.equal(c.state, "ready");
    assert.equal(c.target, "x");
  });
});

test("an unknown need is invalid_input and adds no rows", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    await assert.rejects(createTask(db, bot, { room: "build", brief: "x", needs: ["th_nope"] }), code("invalid_input"));
    assert.equal(await count(db), 0);
    assert.equal((await db`select count(*)::int as n from threads`)[0]!.n, 0);
    assert.equal((await listEvents(db, {})).events.length, 0);
  });
});

test("invalid input is rejected", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    await assert.rejects(createTask(db, bot, { room: "build", brief: "" }), code("invalid_input"));
    await assert.rejects(createTask(db, bot, { room: "Bad Room", brief: "x" }), code("invalid_input"));
    await assert.rejects(createTask(db, bot, { room: "build", brief: "x", target: "t".repeat(201) }), code("invalid_input"));
    assert.equal(await count(db), 0);
  });
});

test("NUL or a lone surrogate in a target or need id is invalid_input", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    for (const d of ["a\u0000b", "a\uD800b", "a\uDC00b"]) {
      await assert.rejects(createTask(db, bot, { room: "build", brief: "x", target: d }), code("invalid_input"));
      await assert.rejects(createTask(db, bot, { room: "build", brief: "x", needs: [d] }), code("invalid_input"));
      await assert.rejects(createPlan(db, bot, "build", [{ key: "a", text: "x", target: d }]), code("invalid_input"));
      await assert.rejects(createPlan(db, bot, "build", [{ key: "a", text: "x", needs: [{ id: d }] }]), code("invalid_input"));
    }
    assert.equal(await count(db), 0);
  });
});

test("no create grant is forbidden", async () => {
  await withTestDb(async (db) => {
    const ro = await agentAuth(db, "ro", [{ room: "*", perms: ["read", "post"] }]);
    await assert.rejects(createTask(db, ro, { room: "build", brief: "x" }), code("forbidden"));
    await assert.rejects(createPlan(db, ro, "build", [{ key: "a", text: "x" }]), code("forbidden"));
    assert.equal(await count(db), 0);
  });
});

test("plan: review needing limiter is waiting; order and events are stable", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    // Listed out of order on purpose: dependencies must still be inserted first.
    const out = await createPlan(db, bot, "build", [
      { key: "review", text: "review it", needs: [{ key: "limiter" }, { key: "docs" }] },
      { key: "limiter", text: "write limiter" },
      { key: "docs", text: "write docs", needs: [{ key: "limiter" }] },
    ]);
    assert.deepEqual(Object.keys(out), ["review", "limiter", "docs"]);
    assert.equal(out.limiter!.state, "ready");
    assert.equal(out.docs!.state, "waiting");
    assert.equal(out.review!.state, "waiting");
    assert.deepEqual(out.review!.needs, [out.docs!.id, out.limiter!.id].sort());
    assert.equal(out.review!.needStates[out.limiter!.id], "ready");

    const { events } = await listEvents(db, {});
    assert.deepEqual(
      events.map((e) => e.threadId),
      [out.limiter!.id, out.docs!.id, out.review!.id],
    );
    const rows = await db`select id from threads order by created_at, id`;
    assert.deepEqual(
      rows.map((r) => r.id),
      [out.limiter!.id, out.docs!.id, out.review!.id],
    );
  });
});

test("plan: an already-ordered plan keeps its order; {id} needs work", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const base = await createTask(db, bot, { room: "build", brief: "base" });
    await db`update tasks set state = 'completed' where thread_id = ${base.id}`;
    const out = await createPlan(db, bot, "build", [
      { key: "a", text: "a", needs: [{ id: base.id }] },
      { key: "b", text: "b" },
      { key: "c", text: "c", needs: [{ key: "b" }] },
    ]);
    assert.equal(out.a!.state, "ready");
    assert.equal(out.c!.state, "waiting");
    const { events } = await listEvents(db, { after: "1" });
    assert.deepEqual(events.map((e) => e.threadId), [out.a!.id, out.b!.id, out.c!.id]);
    await assert.rejects(
      createPlan(db, bot, "build", [{ key: "z", text: "z", needs: [{ id: "th_nope" }] }]),
      code("invalid_input"),
    );
  });
});

test("plan: cycle, unknown key and duplicate key are invalid_input with nothing created", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const bad: [string, Parameters<typeof createPlan>[3]][] = [
      ["a", [{ key: "a", text: "a", needs: [{ key: "b" }] }, { key: "b", text: "b", needs: [{ key: "a" }] }]],
      ["ghost", [{ key: "a", text: "a", needs: [{ key: "ghost" }] }]],
      ["a", [{ key: "a", text: "1" }, { key: "a", text: "2" }]],
      ["a", [{ key: "a", text: "a", needs: [{ key: "a" }] }]],
    ];
    for (const [key, plan] of bad) {
      await assert.rejects(createPlan(db, bot, "build", plan), (e) => {
        assert.ok(code("invalid_input")(e));
        assert.ok((e as Error).message.includes(`"${key}"`), (e as Error).message);
        return true;
      });
    }
    await assert.rejects(createPlan(db, bot, "build", []), code("invalid_input"));
    await assert.rejects(createPlan(db, bot, "build", [{ key: "bad key", text: "x" }]), code("invalid_input"));
    const big = Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, text: "x" }));
    await assert.rejects(createPlan(db, bot, "build", big), code("invalid_input"));
    assert.equal(await count(db), 0);
    assert.equal((await listEvents(db, {})).events.length, 0);
  });
});

test("task.created events are valid AG-UI and data.state matches the task", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const a = await createTask(db, bot, { room: "build", brief: "a", labels: { k: "v" } });
    const b = await createTask(db, bot, { room: "build", brief: "b", needs: [a.id] });
    const { events } = await listEvents(db, {});
    assert.equal(events.length, 2);
    for (const e of events) assertAguiValid(e.agui);
    assert.deepEqual(events.map((e) => e.kind), ["task.created", "task.created"]);
    assert.equal(events[0]!.data.state, a.state);
    assert.equal(events[1]!.data.state, b.state);
    assert.equal(events[0]!.data.taskId, a.id);
    assert.deepEqual(events[0]!.data.labels, { k: "v" });
    assert.deepEqual(events[1]!.data.needs, [a.id]);
    const first = events[0]!.agui[0] as { type: string; name: string };
    assert.equal(first.name, "teamkit.task.created");
    const msgs = await db`select message from messages where thread_id = ${a.id}`;
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0]!.message as { content: string }).content, "a");
  });
});

test("a need in a room the caller cannot read is reported like an unknown id", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const hidden = await createTask(db, ada, { room: "secret", brief: "hidden" });
    const seen = await createTask(db, ada, { room: "build", brief: "seen" });
    const bot = await agentAuth(db, "bot", [{ room: "build", perms: ["read", "create"] }]);
    const before = await count(db);
    const sameAsUnknown = (id: string) => (e: unknown) =>
      (e as { code?: string }).code === "invalid_input" && (e as Error).message === `unknown need ${id}`;
    await assert.rejects(createTask(db, bot, { room: "build", brief: "x", needs: ["th_nope"] }), sameAsUnknown("th_nope"));
    await assert.rejects(createTask(db, bot, { room: "build", brief: "x", needs: [seen.id, hidden.id] }), sameAsUnknown(hidden.id));
    await assert.rejects(
      createPlan(db, bot, "build", [{ key: "a", text: "x", needs: [{ id: hidden.id }] }]),
      sameAsUnknown(hidden.id),
    );
    assert.equal(await count(db), before);
    const ok = await createTask(db, bot, { room: "build", brief: "x", needs: [seen.id] });
    assert.deepEqual(ok.needStates, { [seen.id]: "ready" });
    const mine = await createTask(db, ada, { room: "build", brief: "y", needs: [hidden.id] });
    assert.deepEqual(mine.needs, [hidden.id]);
  });
});

async function seedTask(db: Db, id: string, state: string, by: string, needs: string[] = []): Promise<void> {
  await db`insert into rooms (name) values ('build') on conflict do nothing`;
  await db`insert into threads (id, room, is_task, created_by) values (${id}, 'build', true, ${by})`;
  await db`insert into tasks (thread_id, state, brief) values (${id}, ${state}, ${id})`;
  for (const n of needs) await db`insert into task_needs (task_id, needs_id) values (${id}, ${n})`;
}

/** Resolves once some other session of this database is waiting on a row lock. */
async function untilLockWait(db: Db): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [r] = await db`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    if (r!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no session started waiting on a lock");
}

// th_b is the need and th_a waits on it; ids sort th_a first. createTask locks its
// needs in id order (th_a, then th_b) while complete(th_b) locks th_b and then its
// dependent th_a, so the two can deadlock whatever order createTask uses.
test("createTask that loses a deadlock to complete() is retried and succeeds", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    await seedTask(db, "th_b", "claimed", bot.actor.id);
    await seedTask(db, "th_a", "waiting", bot.actor.id, ["th_b"]);
    const completing = await db.reserve();
    try {
      // complete()'s two locking statements, with a long deadlock_timeout so that
      // createTask's backend is the one that detects the cycle and is aborted.
      await completing`begin`;
      await completing`set local deadlock_timeout = '10s'`;
      await completing`select thread_id from tasks where thread_id = 'th_b' for update`;
      const created = createTask(db, bot, { room: "build", brief: "z", needs: ["th_b", "th_a"] });
      await untilLockWait(db);
      await completing`
        select thread_id from tasks
        where state = 'waiting' and thread_id in (select task_id from task_needs where needs_id = 'th_b')
        order by thread_id for update`;
      await completing`commit`;
      const z = await created;
      assert.equal(z.state, "waiting");
      assert.deepEqual(z.needs, ["th_a", "th_b"]);
    } finally {
      await completing`rollback`.catch(() => {});
      completing.release();
    }
  });
});

test("complete() that loses a deadlock to createTask is retried and promotes the dependent", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    await seedTask(db, "th_b", "ready", bot.actor.id);
    await seedTask(db, "th_a", "waiting", bot.actor.id, ["th_b"]);
    const claim = await claimTask(db, bot, "th_b");
    const creating = await db.reserve();
    try {
      // createTask's lockNeeds, one row at a time, with complete() as the victim.
      await creating`begin`;
      await creating`set local deadlock_timeout = '10s'`;
      await creating`select thread_id from tasks where thread_id = 'th_a' for share`;
      const completed = complete(db, bot, "th_b", claim.claimId, "done");
      await untilLockWait(db);
      await creating`select thread_id from tasks where thread_id = 'th_b' for share`;
      await creating`commit`;
      const b = await completed;
      assert.equal(b.state, "completed");
      assert.equal((await loadTask(db, "th_a"))!.state, "ready");
    } finally {
      await creating`rollback`.catch(() => {});
      creating.release();
    }
  });
});

test("complete() racing createTask over a need and its dependent never surfaces a deadlock", async () => {
  await withTestDb(async (admin, url) => {
    // Detect deadlocks in milliseconds, not the default second, so the race can run many times.
    const [{ name }] = await admin`select current_database() as name`;
    await admin.unsafe(`alter database "${name}" set deadlock_timeout = '20ms'`);
    const db = createDb(url);
    try {
      const bot = await agentAuth(db, "bot");
      for (let i = 0; i < 40; i++) {
        const x = await createTask(db, bot, { room: "build", brief: `x${i}` });
        const y = await createTask(db, bot, { room: "build", brief: `y${i}`, needs: [x.id] });
        const claim = await claimTask(db, bot, x.id);
        const [done, z] = await Promise.all([
          complete(db, bot, x.id, claim.claimId, null),
          createTask(db, bot, { room: "build", brief: `z${i}`, needs: [x.id, y.id] }),
        ]);
        assert.equal(done.state, "completed");
        assert.equal(z.state, "waiting");
        assert.equal((await loadTask(db, y.id))!.state, "ready");
      }
    } finally {
      await db.end({ timeout: 5 });
    }
  });
});

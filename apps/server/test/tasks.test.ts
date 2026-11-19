import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createPlan, createTask } from "../src/store/tasks.js";
import { listEvents } from "../src/store/events.js";
import type { Db } from "../src/db/pool.js";

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

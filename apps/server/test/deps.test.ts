import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createPlan } from "../src/store/tasks.js";
import { claimTask, complete, fail } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { listTasks } from "../src/store/task-list.js";

test("review stays waiting until limiter completes; task.ready follows task.completed", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const out = await createPlan(db, bot, "build", [
      { key: "limiter", text: "write limiter" },
      { key: "review", text: "review it", needs: [{ key: "limiter" }] },
    ]);
    const { limiter, review } = out as Record<string, { id: string }>;
    const c = await claimTask(db, bot, limiter!.id);
    const [mid] = await listTasks(db, bot, { state: "waiting" });
    assert.equal(mid!.id, review!.id);
    await complete(db, bot, limiter!.id, c.claimId, "done");
    const [after] = await listTasks(db, bot, { state: "ready" });
    assert.equal(after!.id, review!.id);
    const { events } = await listEvents(db, {});
    const completed = events.find((e) => e.kind === "task.completed" && e.threadId === limiter!.id)!;
    const ready = events.find((e) => e.kind === "task.ready" && e.threadId === review!.id)!;
    assert.ok(BigInt(ready.cursor) > BigInt(completed.cursor));
    assert.equal(ready.room, "build");
    assert.deepEqual(ready.data, { taskId: review!.id, state: "ready", reason: "dependencies_met" });
    assertAguiValid(ready.agui);
  });
});

test("a dependent with two needs is promoted only when both complete", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const out = await createPlan(db, bot, "build", [
      { key: "a", text: "a" },
      { key: "b", text: "b" },
      { key: "c", text: "c", needs: [{ key: "a" }, { key: "b" }] },
    ]);
    const ca = await claimTask(db, bot, out.a!.id);
    const cb = await claimTask(db, bot, out.b!.id);
    await complete(db, bot, out.a!.id, ca.claimId, null);
    assert.equal((await listTasks(db, bot, { state: "waiting" }))[0]!.id, out.c!.id);
    await complete(db, bot, out.b!.id, cb.claimId, null);
    assert.equal((await listTasks(db, bot, { state: "ready" }))[0]!.id, out.c!.id);
  });
});

test("two needs completing concurrently still promote the dependent exactly once", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    for (let round = 0; round < 5; round++) {
      const out = await createPlan(db, bot, `r${round}`, [
        { key: "a", text: "a" },
        { key: "b", text: "b" },
        { key: "c", text: "c", needs: [{ key: "a" }, { key: "b" }] },
      ]);
      const ca = await claimTask(db, bot, out.a!.id);
      const cb = await claimTask(db, bot, out.b!.id);
      await Promise.all([
        complete(db, bot, out.a!.id, ca.claimId, null),
        complete(db, bot, out.b!.id, cb.claimId, null),
      ]);
      const [row] = await db`select state from tasks where thread_id = ${out.c!.id}`;
      assert.equal(row!.state, "ready");
      const { events } = await listEvents(db, { threadId: out.c!.id, kinds: ["task.ready"] });
      assert.equal(events.length, 1);
    }
  });
});

test("a failed need leaves the dependent waiting", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const out = await createPlan(db, bot, "build", [
      { key: "limiter", text: "write limiter" },
      { key: "review", text: "review it", needs: [{ key: "limiter" }] },
    ]);
    const c = await claimTask(db, bot, out.limiter!.id);
    await fail(db, bot, out.limiter!.id, c.claimId, "could not build");
    const [t] = await listTasks(db, bot, {});
    assert.equal(t!.id, out.review!.id);
    assert.equal(t!.state, "waiting");
    assert.equal(t!.needStates[out.limiter!.id], "failed");
    const { events } = await listEvents(db, { kinds: ["task.ready"] });
    assert.equal(events.length, 0);
  });
});

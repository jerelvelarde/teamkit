import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { listTasks } from "../src/store/task-list.js";
import type { Db } from "../src/db/pool.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

async function seedTask(
  db: Db,
  id: string,
  room: string,
  state: string,
  labels: Record<string, string> = {},
  createdBy = "p0",
) {
  await db`insert into rooms (name) values (${room}) on conflict do nothing`;
  await db`insert into threads (id, room, is_task, labels, created_by) values (${id}, ${room}, true, ${db.json(labels)}, ${createdBy})`;
  await db`insert into tasks (thread_id, state, brief) values (${id}, ${state}, ${"brief " + id})`;
}

async function base(db: Db) {
  await db`insert into actors (id, kind, name, role) values ('p0','person','seed','admin')`;
}

const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

test("default hides completed and failed; all shows them; state filters", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const p = await personAuth(db, "ann");
    await seedTask(db, "t1", "build", "ready");
    await seedTask(db, "t2", "build", "completed");
    await seedTask(db, "t3", "build", "failed");
    await seedTask(db, "t4", "build", "waiting");
    assert.deepEqual(ids(await listTasks(db, p, {})), ["t1", "t4"]);
    assert.deepEqual(ids(await listTasks(db, p, { state: "all" })), ["t1", "t2", "t3", "t4"]);
    assert.deepEqual(ids(await listTasks(db, p, { state: "waiting" })), ["t4"]);
    assert.deepEqual(ids(await listTasks(db, p, { state: "completed" })), ["t2"]);
  });
});

test("room prefix includes the room and children, exact excludes children", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const p = await personAuth(db, "ann");
    await seedTask(db, "t1", "build", "ready");
    await seedTask(db, "t2", "build/x", "ready");
    await seedTask(db, "t3", "builder", "ready");
    assert.deepEqual(ids(await listTasks(db, p, { room: "build/" })), ["t1", "t2"]);
    assert.deepEqual(ids(await listTasks(db, p, { room: "build" })), ["t1"]);
    assert.deepEqual(ids(await listTasks(db, p, { room: "*" })), ["t1", "t2", "t3"]);
  });
});

test("agents see only readable rooms; an unreadable room is forbidden", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const a = await agentAuth(db, "bot", [{ room: "build/", perms: ["read"] }]);
    await seedTask(db, "t1", "build", "ready");
    await seedTask(db, "t2", "build/x", "ready");
    await seedTask(db, "t3", "secret", "ready");
    assert.deepEqual(ids(await listTasks(db, a, {})), ["t1", "t2"]);
    assert.deepEqual(ids(await listTasks(db, a, { room: "*" })), ["t1", "t2"]);
    assert.deepEqual(ids(await listTasks(db, a, { room: "build/" })), ["t1", "t2"]);
    await assert.rejects(listTasks(db, a, { room: "secret" }), code("forbidden"));
  });
});

test("an exact grant on a room does not reach its children through a prefix query", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const a = await agentAuth(db, "bot", [{ room: "build", perms: ["read"] }]);
    await seedTask(db, "t1", "build", "ready");
    await seedTask(db, "t2", "build/secret", "ready");
    assert.deepEqual(ids(await listTasks(db, a, { room: "build/" })), ["t1"]);
    assert.deepEqual(ids(await listTasks(db, a, { room: "build" })), ["t1"]);
    assert.deepEqual(ids(await listTasks(db, a, {})), ["t1"]);
    await assert.rejects(listTasks(db, a, { room: "build/secret" }), code("forbidden"));
  });
});

test("labels filter by containment", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const p = await personAuth(db, "ann");
    await seedTask(db, "t1", "build", "ready", { role: "worker", x: "1" });
    await seedTask(db, "t2", "build", "ready", { role: "lead" });
    await seedTask(db, "t3", "build", "ready");
    assert.deepEqual(ids(await listTasks(db, p, { labels: { role: "worker" } })), ["t1"]);
  });
});

test("a waiting task shows which need failed", async () => {
  await withTestDb(async (db) => {
    await base(db);
    const p = await personAuth(db, "ann");
    await seedTask(db, "t1", "build", "failed");
    await seedTask(db, "t2", "build", "waiting");
    await db`insert into task_needs (task_id, needs_id) values ('t2','t1')`;
    const [t] = await listTasks(db, p, {});
    assert.equal(t!.id, "t2");
    assert.deepEqual(t!.needs, ["t1"]);
    assert.equal(t!.needStates["t1"], "failed");
  });
});

test("bad state or room is invalid_input", async () => {
  await withTestDb(async (db) => {
    const p = await personAuth(db, "ann");
    await assert.rejects(listTasks(db, p, { state: "bogus" as never }), code("invalid_input"));
    await assert.rejects(listTasks(db, p, { room: "Bad Room" }), code("invalid_input"));
  });
});

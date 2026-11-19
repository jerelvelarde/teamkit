import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { registerAgent } from "../src/dispatch/registry.js";
import { createTask } from "../src/store/tasks.js";
import { currentCursor } from "../src/store/events.js";
import { agentAuth } from "./helpers/actors.js";
import {
  addTrigger,
  advanceTrigger,
  listStoredTriggers,
  listTriggers,
  removeTrigger,
  setTriggerEnabled,
} from "../src/triggers/store.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("a webhook trigger gets a whsec_ secret and starts at the current head", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "maker");
    await createTask(db, a, { room: "build", brief: "x" });
    const head = await currentCursor(db);
    assert.notEqual(head, "0");
    const created = await addTrigger(db, {
      name: "hook",
      room: "build/",
      kinds: ["task.blocked"],
      webhook: "https://example.com/h",
    });
    assert.match(created.secret ?? "", /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.trigger.cursor, head);
    assert.deepEqual(created.trigger.action, { type: "webhook", url: "https://example.com/h" });
    assert.equal("secret" in created.trigger, false);
    const [stored] = await listStoredTriggers(db);
    assert.equal(stored!.secret, created.secret);
  });
});

test("an agent trigger needs a registered agent and has no secret", async () => {
  await withTestDb(async (db) => {
    await assert.rejects(
      addTrigger(db, { name: "t", room: "*", kinds: ["task.ready"], agent: "ghost" }),
      code("invalid_input"),
    );
    await registerAgent(db, { name: "lead", url: "http://127.0.0.1:9/a", rooms: ["build"] });
    const c = await addTrigger(db, { name: "t", room: "*", kinds: ["task.ready"], agent: "lead", labels: { a: "b" } });
    assert.equal(c.secret, null);
    assert.deepEqual(c.trigger.action, { type: "agent", agent: "lead" });
    assert.deepEqual(c.trigger.labels, { a: "b" });
  });
});

test("invalid input is rejected", async () => {
  await withTestDb(async (db) => {
    const base = { name: "t", room: "*", kinds: ["task.ready" as const] };
    await assert.rejects(addTrigger(db, { ...base, webhook: "https://x.test/", agent: "lead" }), code("invalid_input"));
    await assert.rejects(addTrigger(db, base), code("invalid_input"));
    await assert.rejects(addTrigger(db, { ...base, kinds: ["nope" as never], webhook: "https://x.test/" }), code("invalid_input"));
    await assert.rejects(addTrigger(db, { ...base, kinds: [], webhook: "https://x.test/" }), code("invalid_input"));
    await assert.rejects(addTrigger(db, { ...base, webhook: "ftp://x.test/" }), code("invalid_input"));
    await assert.rejects(addTrigger(db, { ...base, name: "Bad Name", webhook: "https://x.test/" }), code("invalid_input"));
    await assert.rejects(addTrigger(db, { ...base, room: "Bad Room!", webhook: "https://x.test/" }), code("invalid_input"));
    await addTrigger(db, { ...base, webhook: "https://x.test/" });
    await assert.rejects(addTrigger(db, { ...base, webhook: "https://x.test/" }), code("invalid_input"));
  });
});

test("listTriggers hides secrets; advance never moves back; remove deletes", async () => {
  await withTestDb(async (db) => {
    const c = await addTrigger(db, { name: "t", room: "*", kinds: ["task.ready"], webhook: "https://x.test/" });
    const listed = await listTriggers(db);
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(c.secret!), false);
    assert.equal("secret" in listed[0]!, false);
    await advanceTrigger(db, c.trigger.id, "10");
    await advanceTrigger(db, c.trigger.id, "5");
    assert.equal((await listTriggers(db))[0]!.cursor, "10");
    await setTriggerEnabled(db, "t", false);
    assert.equal((await listStoredTriggers(db)).length, 0);
    await setTriggerEnabled(db, "t", true);
    assert.equal((await listStoredTriggers(db)).length, 1);
    await removeTrigger(db, "t");
    assert.deepEqual(await listTriggers(db), []);
    await assert.rejects(removeTrigger(db, "t"), code("not_found"));
    await assert.rejects(setTriggerEnabled(db, "t", true), code("not_found"));
  });
});

test("addTrigger refuses a webhook url with embedded credentials", async () => {
  await withTestDb(async (db) => {
    const base = { name: "n", room: "build/", kinds: ["task.completed" as const] };
    for (const webhook of ["https://user:pw@x.test/h", "https://user@x.test/h"]) {
      await assert.rejects(addTrigger(db, { ...base, webhook }), code("invalid_input"), webhook);
    }
    assert.equal((await listTriggers(db)).length, 0);
  });
});

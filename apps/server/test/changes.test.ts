import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { BRIEF, billingTeam } from "./helpers/team.js";
import { listChanges, loadChanges, logChange, updateChange } from "../src/store/changes.js";
import { listEvents } from "../src/store/events.js";
import { createTask } from "../src/store/tasks.js";

const code = (c: string, msg?: RegExp) => (e: unknown) =>
  (e as { code?: string }).code === c && (msg === undefined || msg.test((e as Error).message));
const valueOf = (x: unknown) => (x as { value: unknown }).value;

const ADD_COLUMN = { what: "Added column invoices.currency_code", where: "billing-prod database",
  undo: "alter table invoices drop column currency_code", undoWhen: "if the backfill fails" };

test("ben-agent logs a change for ben on a task's thread", async () => {
  await withTestDb(async (db) => {
    const { ben, benAgent } = await billingTeam(db);
    const t = await createTask(db, benAgent.auth, { room: "billing-prod", brief: BRIEF });
    const c = await logChange(db, benAgent.auth, { room: "billing-prod", threadId: t.id, ...ADD_COLUMN });
    assert.deepEqual([c.person, c.agent, c.status, c.threadId, c.undoWhen], [ben.actor, benAgent.actor, "active", t.id, "if the backfill fails"]);
    assert.ok(Math.abs(Date.parse(c.at) - Date.now()) < 5_000);
    const [e] = (await listEvents(db, { kinds: ["change.logged"] })).events;
    assert.equal(e!.threadId, t.id);
    assert.deepEqual(e!.data, { changeId: c.id, status: "active" });
    assertAguiValid(e!.agui);
    assert.deepEqual(valueOf(e!.agui[0]), { change: c });
  });
});

test("sam logs a change himself and keeps the time he gives", async () => {
  await withTestDb(async (db) => {
    const { sam } = await billingTeam(db);
    const c = await logChange(db, sam.auth, { room: "billing-prod", ...ADD_COLUMN, at: "2026-11-19T14:00:00.000Z" });
    assert.deepEqual([c.person, c.agent, c.at], [sam.actor, null, "2026-11-19T14:00:00.000Z"]);
  });
});

test("a change with no task is a room event with no thread", async () => {
  await withTestDb(async (db) => {
    const { benAgent } = await billingTeam(db);
    const c = await logChange(db, benAgent.auth, { room: "billing-migration", ...ADD_COLUMN });
    assert.equal(c.threadId, null);
    const [e] = (await listEvents(db, { kinds: ["change.logged"] })).events;
    assert.equal(e!.threadId, null);
    assert.equal(e!.room, "billing-migration");
    assert.deepEqual(await loadChanges(db, [c.id, "chg_0000000000000000"]), [c]);
  });
});

test("logChange validates its fields, its thread and who logs it", async () => {
  await withTestDb(async (db) => {
    const { benAgent, samAgent, anaAgent } = await billingTeam(db);
    for (const missing of ["what", "where", "undo"] as const) {
      const input = { room: "billing-prod", ...ADD_COLUMN } as Record<string, unknown>;
      delete input[missing];
      await assert.rejects(logChange(db, benAgent.auth, input as never), code("invalid_input"), missing);
    }
    await assert.rejects(logChange(db, benAgent.auth, { room: "billing-prod", ...ADD_COLUMN, where: "x".repeat(201) }), code("invalid_input"));
    await assert.rejects(logChange(db, benAgent.auth, { room: "billing-prod", ...ADD_COLUMN, at: "yesterday" }), code("invalid_input"));
    const t = await createTask(db, benAgent.auth, { room: "billing-migration", brief: BRIEF });
    await assert.rejects(logChange(db, benAgent.auth, { room: "billing-prod", threadId: t.id, ...ADD_COLUMN }), code("invalid_input"));
    await assert.rejects(logChange(db, benAgent.auth, { room: "billing-prod", threadId: "th_0000000000000000", ...ADD_COLUMN }), code("not_found"));
    await db`update actors set owner_id = null where id = ${samAgent.actor.id}`;
    await assert.rejects(logChange(db, samAgent.auth, { room: "billing-prod", ...ADD_COLUMN }), code("forbidden", /has no owner/));
    await db`update grants set perms = '{read}' where actor_id = ${anaAgent.actor.id}`;
    await assert.rejects(logChange(db, anaAgent.auth, { room: "billing-prod", ...ADD_COLUMN }), code("forbidden"));
  });
});

test("status moves among active, done and restored; the same status is a no-op", async () => {
  await withTestDb(async (db) => {
    const { sam } = await billingTeam(db);
    const c = await logChange(db, sam.auth, { room: "billing-prod", ...ADD_COLUMN });
    const done = await updateChange(db, sam.auth, c.id, "done");
    assert.equal(done.status, "done");
    const [e] = (await listEvents(db, { kinds: ["change.updated"] })).events;
    assert.deepEqual(e!.data, { changeId: c.id, status: "done", previous: "active" });
    assert.deepEqual(valueOf(e!.agui[0]), { changeId: c.id, status: "done", previous: "active" });
    await updateChange(db, sam.auth, c.id, "done");
    assert.equal((await listEvents(db, { kinds: ["change.updated"] })).events.length, 1);
    await assert.rejects(updateChange(db, sam.auth, c.id, "undone" as never), code("invalid_input"));
    assert.equal((await updateChange(db, sam.auth, c.id, "restored")).status, "restored");
  });
});

test("changes list newest by at, filter by status, and need read", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const c1 = await logChange(db, sam.auth, { room: "billing-prod", ...ADD_COLUMN, at: "2026-11-19T13:00:00.000Z" });
    const c2 = await logChange(db, sam.auth, { room: "billing-prod", ...ADD_COLUMN, at: "2026-11-19T14:00:00.000Z" });
    assert.deepEqual((await listChanges(db, sam.auth, "billing-prod")).map((c) => c.id), [c2.id, c1.id]);
    await updateChange(db, sam.auth, c1.id, "done");
    assert.deepEqual((await listChanges(db, sam.auth, "billing-prod", { status: "active" })).map((c) => c.id), [c2.id]);
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-prod'`;
    await assert.rejects(listChanges(db, benAgent.auth, "billing-prod"), code("forbidden"));
  });
});

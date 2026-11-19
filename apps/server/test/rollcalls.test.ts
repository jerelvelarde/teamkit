import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { billingTeam } from "./helpers/team.js";
import { answerRollCall, listRollCalls, startRollCall } from "../src/store/rollcalls.js";
import { listEvents } from "../src/store/events.js";
import { getThread } from "../src/store/threads.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const said = async (db: Parameters<typeof getThread>[0], auth: Parameters<typeof getThread>[1], threadId: string) =>
  (await getThread(db, auth, threadId)).messages.map((m) => [m.role, (m as { name?: string }).name, (m as { content?: string }).content]);

test("ana starts a roll call on its own thread", async () => {
  await withTestDb(async (db) => {
    const { ana } = await billingTeam(db);
    const r = await startRollCall(db, ana.auth, "billing-migration");
    assert.deepEqual(r.askedBy, ana.actor);
    assert.deepEqual(r.answers, []);
    assert.match(r.threadId, /^th_/);
    assert.deepEqual(await said(db, ana.auth, r.threadId), [["user", "ana", "Roll call: who is on in billing-migration?"]]);
    const [e] = (await listEvents(db, { kinds: ["rollcall.started"] })).events;
    assert.equal(e!.threadId, r.threadId);
    assert.deepEqual(e!.data.rollCallId, r.id);
    assertAguiValid(e!.agui);
  });
});

test("agents answer; a second answer replaces the first", async () => {
  await withTestDb(async (db) => {
    const { ana, benAgent, samAgent } = await billingTeam(db);
    const r = await startRollCall(db, ana.auth, "billing-migration");
    await answerRollCall(db, benAgent.auth, r.id, "on: watching billing-migration");
    await answerRollCall(db, samAgent.auth, r.id, "on");
    const last = await answerRollCall(db, benAgent.auth, r.id, "off: back at 09:00");
    assert.deepEqual(last.answers.map((a) => [a.actor, a.status]), [[samAgent.actor, "on"], [benAgent.actor, "off: back at 09:00"]]);
    const answered = (await listEvents(db, { kinds: ["rollcall.answered"] })).events;
    assert.equal(answered.length, 3);
    for (const e of answered) assertAguiValid(e.agui);
    const lines = await said(db, ana.auth, r.threadId);
    assert.deepEqual(lines[lines.length - 1], ["assistant", "ben-agent", "off: back at 09:00"]);
  });
});

test("an answer needs a short status and post in the room; an unknown id is not_found", async () => {
  await withTestDb(async (db) => {
    const { ana, benAgent } = await billingTeam(db);
    const r = await startRollCall(db, ana.auth, "billing-migration");
    await assert.rejects(answerRollCall(db, benAgent.auth, r.id, ""), code("invalid_input"));
    await assert.rejects(answerRollCall(db, benAgent.auth, r.id, "x".repeat(201)), code("invalid_input"));
    await assert.rejects(answerRollCall(db, benAgent.auth, "rc_0000000000000000", "on"), code("not_found"));
    await db`update grants set perms = '{read}' where actor_id = ${benAgent.actor.id}`;
    await assert.rejects(answerRollCall(db, benAgent.auth, r.id, "on"), code("forbidden"));
  });
});

test("roll calls list newest first and need read", async () => {
  await withTestDb(async (db) => {
    const { ana, benAgent } = await billingTeam(db);
    const r1 = await startRollCall(db, ana.auth, "billing-migration");
    const r2 = await startRollCall(db, ana.auth, "billing-migration");
    assert.deepEqual((await listRollCalls(db, ana.auth, "billing-migration")).map((r) => r.id), [r2.id, r1.id]);
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-migration'`;
    await assert.rejects(listRollCalls(db, benAgent.auth, "billing-migration"), code("forbidden"));
  });
});
